"""
Rewir — lokalny notatnik listonosza.
Start:  python server/app.py
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import unquote

from flask import Flask, jsonify, request, send_from_directory

BASE = Path(__file__).resolve().parent.parent
WEB = BASE / "web"
DATA_FILE = BASE / "data" / "data.json"
LOG_FILE = BASE / "data" / "log.jsonl"
SESSIONS_FILE = BASE / "data" / "sessions.json"
AUTH_FILE = BASE / "config" / "auth.json"

# --- настройки ---------------------------------------------------------------
SESSION_TTL = 30 * 24 * 3600     # сотрудник: 30 дней, скользящие
ADMIN_TTL = 2 * 3600             # права админа гаснут через 2 часа
RENEW_AFTER = 24 * 3600          # продлевать сессию не чаще раза в сутки
MAX_FAILS = 5
BLOCK_SECONDS = 300
FAIL_WINDOW = 900
WRONG_PASSWORD_DELAY = 0.4
MAX_NOTE = 400
MAX_LABEL = 30
MAX_CODE = 40
MAX_AUTHOR = 24
MAX_CODES_PER_HOUSE = 12
ANON = "Nieznany"
SCORED = ("house_add", "code_add", "note_set")
TRUST_PROXY = os.environ.get("TRUST_PROXY") == "1"
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") == "1"

app = Flask(__name__, static_folder=None)

_data_lock = threading.Lock()
_log_lock = threading.Lock()
_sess_lock = threading.Lock()
_fails_lock = threading.Lock()
_sessions = {}
_fails = {}


# --- низкий уровень ----------------------------------------------------------
def atomic_write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


def clean(text, limit) -> str:
    return re.sub(r"[\x00-\x1f]", "", str(text or "")).strip()[:limit]


# --- пароли ------------------------------------------------------------------
def hash_password(password: str, salt: bytes = None) -> dict:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return {"salt": salt.hex(), "hash": digest.hex(), "ver": 1}


def check_password(password: str, record: dict) -> bool:
    salt = bytes.fromhex(record["salt"])
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(digest.hex(), record["hash"])


def load_auth() -> dict:
    if AUTH_FILE.exists():
        cfg = json.loads(AUTH_FILE.read_text("utf-8"))
        for role in ("view", "admin"):
            cfg[role].setdefault("ver", 1)
        return cfg
    view, admin = secrets.token_urlsafe(9), secrets.token_urlsafe(12)
    cfg = {"view": hash_password(view), "admin": hash_password(admin)}
    save_auth(cfg)
    print("\n" + "=" * 58)
    print("  Файл паролей создан. Запишите — второй раз не покажем.")
    print(f"  Пароль доступа (сотрудник) : {view}")
    print(f"  Пароль администратора      : {admin}")
    print("=" * 58 + "\n")
    return cfg


def save_auth(cfg: dict) -> None:
    atomic_write(AUTH_FILE, cfg)
    try:
        os.chmod(AUTH_FILE, 0o600)
    except OSError:
        pass


# --- сессии на диске ---------------------------------------------------------
def load_sessions() -> None:
    global _sessions
    if not SESSIONS_FILE.exists():
        _sessions = {}
        return
    try:
        raw = json.loads(SESSIONS_FILE.read_text("utf-8"))
    except json.JSONDecodeError:
        raw = {}
    now = time.time()
    _sessions = {t: s for t, s in raw.items() if s.get("exp", 0) > now}


def flush_sessions() -> None:
    atomic_write(SESSIONS_FILE, _sessions)
    try:
        os.chmod(SESSIONS_FILE, 0o600)
    except OSError:
        pass


def session():
    """Возвращает (token, sess) живой сессии либо (None, None)."""
    token = request.cookies.get("sid")
    if not token:
        return None, None
    with _sess_lock:
        sess = _sessions.get(token)
        if not sess:
            return None, None
        now = time.time()
        if sess["exp"] < now:
            _sessions.pop(token, None)
            flush_sessions()
            return None, None
        cfg = load_auth()
        # смена пароля роли поднимает ver и убивает все её токены
        if sess.get("view_ver") != cfg["view"]["ver"]:
            _sessions.pop(token, None)
            flush_sessions()
            return None, None
        if sess.get("admin_until", 0) > now and sess.get("admin_ver") != cfg["admin"]["ver"]:
            sess["admin_until"] = 0
            flush_sessions()
        return token, sess


def current_role():
    _, sess = session()
    if not sess:
        return None
    return "admin" if sess.get("admin_until", 0) > time.time() else "user"


def require(role=None):
    actual = current_role()
    if actual is None:
        return None, (jsonify(error="Wymagane logowanie"), 401)
    if role == "admin" and actual != "admin":
        return None, (jsonify(error="Włącz tryb administratora"), 403)
    return actual, None


# --- журнал ------------------------------------------------------------------
def author_name() -> str:
    return clean(unquote(request.headers.get("X-Author", "")), MAX_AUTHOR) or ANON


def log(action: str, target: str = "", extra: str = "") -> None:
    entry = {
        "ts": int(time.time()), "author": author_name(), "role": current_role() or "?",
        "ip": client_ip(), "action": action, "target": target, "extra": extra[:80],
    }
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with _log_lock:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def read_log():
    if not LOG_FILE.exists():
        return []
    out = []
    with _log_lock:
        for line in LOG_FILE.read_text("utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


# --- защита от перебора ------------------------------------------------------
def client_ip() -> str:
    if TRUST_PROXY:
        fwd = request.headers.get("X-Forwarded-For", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.remote_addr or "?"


def blocked_for(ip: str) -> int:
    with _fails_lock:
        rec = _fails.get(ip)
        return max(int(rec["until"] - time.time()), 0) if rec else 0


def register_fail(ip: str) -> None:
    now = time.time()
    with _fails_lock:
        if len(_fails) > 5000:
            for k in [k for k, v in _fails.items() if v["until"] < now][:2500]:
                _fails.pop(k, None)
        rec = _fails.get(ip)
        if not rec or now - rec["first"] > FAIL_WINDOW:
            rec = {"count": 0, "first": now, "until": 0}
        rec["count"] += 1
        if rec["count"] >= MAX_FAILS:
            rec.update(until=now + BLOCK_SECONDS, count=0, first=now)
        _fails[ip] = rec


def clear_fails(ip: str) -> None:
    with _fails_lock:
        _fails.pop(ip, None)


# --- данные ------------------------------------------------------------------
def migrate(data: dict) -> bool:
    """Старое поле code -> список codes. Возвращает True, если что-то изменили."""
    touched = False
    for city in data["cities"]:
        for street in city["streets"]:
            for house in street["houses"]:
                if "codes" not in house:
                    old = house.pop("code", "")
                    entr = house.pop("entrance", "")
                    label = f"Klatka {entr}" if entr else ""
                    house["codes"] = [{"id": new_id("k"), "label": label, "value": old}] if old else []
                    touched = True
                house.pop("entrance", None)
                house.setdefault("note", "")
                house.setdefault("updated", int(time.time()))
    return touched


def load_data() -> dict:
    if not DATA_FILE.exists():
        atomic_write(DATA_FILE, {"cities": []})
    data = json.loads(DATA_FILE.read_text("utf-8"))
    if migrate(data):
        atomic_write(DATA_FILE, data)
    return data


def save_data(data: dict) -> None:
    atomic_write(DATA_FILE, data)


def house_sort_key(house: dict):
    m = re.match(r"(\d+)(.*)", house.get("number", "").strip())
    return (int(m.group(1)), m.group(2)) if m else (10**9, house.get("number", ""))


def find(data, city_id=None, street_id=None, house_id=None):
    for city in data["cities"]:
        if city_id and city["id"] == city_id:
            return city
        for street in city["streets"]:
            if street_id and street["id"] == street_id:
                return street
            for house in street["houses"]:
                if house_id and house["id"] == house_id:
                    return house
    return None


def find_code(data, code_id):
    for city in data["cities"]:
        for street in city["streets"]:
            for house in street["houses"]:
                for code in house["codes"]:
                    if code["id"] == code_id:
                        return house, code
    return None, None


@app.after_request
def headers(resp):
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


# --- статика -----------------------------------------------------------------
@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    return send_from_directory(WEB, filename)


# --- вход --------------------------------------------------------------------
def me_payload(sess):
    now = time.time()
    admin_left = max(int(sess.get("admin_until", 0) - now), 0)
    return {"role": "admin" if admin_left else "user", "admin_left": admin_left}


@app.post("/api/auth/login")
def login():
    ip = client_ip()
    left = blocked_for(ip)
    if left:
        return jsonify(error=f"Za dużo prób. Odczekaj {left} s.", retry_after=left), 429

    password = (request.json or {}).get("password", "")
    cfg = load_auth()
    if not (password and check_password(password, cfg["view"])):
        time.sleep(WRONG_PASSWORD_DELAY)
        register_fail(ip)
        return jsonify(error="Błędne hasło"), 401

    clear_fails(ip)
    token = secrets.token_urlsafe(32)
    now = time.time()
    sess = {"exp": now + SESSION_TTL, "issued": now,
            "view_ver": cfg["view"]["ver"], "admin_until": 0, "admin_ver": 0}
    with _sess_lock:
        _sessions[token] = sess
        flush_sessions()
    resp = jsonify(me_payload(sess))
    resp.set_cookie("sid", token, httponly=True, samesite="Lax",
                    secure=COOKIE_SECURE, max_age=SESSION_TTL)
    return resp


@app.post("/api/auth/elevate")
def elevate():
    token, sess = session()
    if not sess:
        return jsonify(error="Wymagane logowanie"), 401
    ip = client_ip()
    left = blocked_for(ip)
    if left:
        return jsonify(error=f"Za dużo prób. Odczekaj {left} s.", retry_after=left), 429

    cfg = load_auth()
    password = (request.json or {}).get("password", "")
    if not (password and check_password(password, cfg["admin"])):
        time.sleep(WRONG_PASSWORD_DELAY)
        register_fail(ip)
        return jsonify(error="Błędne hasło administratora"), 401

    clear_fails(ip)
    with _sess_lock:
        sess["admin_until"] = time.time() + ADMIN_TTL
        sess["admin_ver"] = cfg["admin"]["ver"]
        flush_sessions()
    log("elevate")
    return jsonify(me_payload(sess))


@app.post("/api/auth/demote")
def demote():
    token, sess = session()
    if not sess:
        return jsonify(error="Wymagane logowanie"), 401
    log("demote")
    with _sess_lock:
        sess["admin_until"] = 0
        flush_sessions()
    return jsonify(me_payload(sess))


@app.post("/api/auth/logout")
def logout():
    token, _ = session()
    if token:
        with _sess_lock:
            _sessions.pop(token, None)
            flush_sessions()
    resp = jsonify(ok=True)
    resp.delete_cookie("sid")
    return resp


@app.get("/api/me")
def me():
    token, sess = session()
    if not sess:
        return jsonify(error="Wymagane logowanie"), 401
    now = time.time()
    if now - sess.get("issued", 0) > RENEW_AFTER:      # скользящее продление
        with _sess_lock:
            sess["exp"] = now + SESSION_TTL
            sess["issued"] = now
            flush_sessions()
    return jsonify(me_payload(sess))


@app.post("/api/admin/password")
def change_password():
    _, err = require("admin")
    if err:
        return err
    body = request.json or {}
    target = body.get("target")
    current, new = body.get("current_password", ""), body.get("new_password", "")
    if target not in ("view", "admin"):
        return jsonify(error="Nieznane hasło"), 400
    if len(new) < 8:
        return jsonify(error="Minimum 8 znaków"), 400

    cfg = load_auth()
    if not check_password(current, cfg["admin"]):
        time.sleep(WRONG_PASSWORD_DELAY)
        register_fail(client_ip())
        return jsonify(error="Błędne hasło administratora"), 401

    ver = cfg[target]["ver"] + 1
    cfg[target] = hash_password(new)
    cfg[target]["ver"] = ver          # версия растёт -> старые токены мертвы
    log("password_change", target)
    save_auth(cfg)
    return jsonify(ok=True, relogin=(target == "view"))


# --- чтение ------------------------------------------------------------------
@app.get("/api/data")
def get_data():
    _, err = require()
    if err:
        return err
    with _data_lock:
        data = load_data()
    for city in data["cities"]:
        for street in city["streets"]:
            street["houses"].sort(key=house_sort_key)
    return jsonify(data)


@app.get("/api/stats")
def stats():
    _, err = require()
    if err:
        return err
    board = {}
    keys = {"house_add": "houses", "code_add": "codes", "note_set": "notes"}
    for e in read_log():
        if e.get("action") not in SCORED:
            continue
        rec = board.setdefault(e["author"], {"name": e["author"], "houses": 0,
                                             "codes": 0, "notes": 0, "total": 0, "last": 0})
        rec[keys[e["action"]]] += 1
        rec["total"] += 1
        rec["last"] = max(rec["last"], e.get("ts", 0))
    return jsonify(ranking=sorted(board.values(), key=lambda r: (-r["total"], r["name"].lower())))


@app.get("/api/log")
def full_log():
    _, err = require("admin")
    if err:
        return err
    return jsonify(entries=read_log()[-300:][::-1])


# --- города и улицы ----------------------------------------------------------
@app.post("/api/cities")
def add_city():
    _, err = require("admin")
    if err:
        return err
    name = clean((request.json or {}).get("name"), 60)
    if not name:
        return jsonify(error="Podaj nazwę miasta"), 400
    with _data_lock:
        data = load_data()
        if any(c["name"].lower() == name.lower() for c in data["cities"]):
            return jsonify(error="Takie miasto już istnieje"), 409
        city = {"id": new_id("c"), "name": name, "streets": []}
        data["cities"].append(city)
        data["cities"].sort(key=lambda c: c["name"].lower())
        save_data(data)
    log("city_add", city["id"], name)
    return jsonify(city), 201


@app.delete("/api/cities/<cid>")
def del_city(cid):
    _, err = require("admin")
    if err:
        return err
    with _data_lock:
        data = load_data()
        target = next((c for c in data["cities"] if c["id"] == cid), None)
        if not target:
            return jsonify(error="Nie znaleziono miasta"), 404
        data["cities"].remove(target)
        save_data(data)
    log("city_del", cid, target["name"])
    return jsonify(ok=True)


@app.post("/api/cities/<cid>/streets")
def add_street(cid):
    _, err = require("admin")
    if err:
        return err
    name = clean((request.json or {}).get("name"), 80)
    if not name:
        return jsonify(error="Podaj nazwę ulicy"), 400
    with _data_lock:
        data = load_data()
        city = find(data, city_id=cid)
        if not city:
            return jsonify(error="Nie znaleziono miasta"), 404
        if any(s["name"].lower() == name.lower() for s in city["streets"]):
            return jsonify(error="Taka ulica już istnieje"), 409
        street = {"id": new_id("s"), "name": name, "houses": []}
        city["streets"].append(street)
        city["streets"].sort(key=lambda s: s["name"].lower())
        save_data(data)
    log("street_add", street["id"], name)
    return jsonify(street), 201


@app.delete("/api/streets/<sid>")
def del_street(sid):
    _, err = require("admin")
    if err:
        return err
    with _data_lock:
        data = load_data()
        for city in data["cities"]:
            target = next((s for s in city["streets"] if s["id"] == sid), None)
            if target:
                city["streets"].remove(target)
                save_data(data)
                log("street_del", sid, target["name"])
                return jsonify(ok=True)
    return jsonify(error="Nie znaleziono ulicy"), 404


# --- дома --------------------------------------------------------------------
@app.post("/api/streets/<sid>/houses")
def add_house(sid):
    _, err = require()                    # дом добавляет любой сотрудник
    if err:
        return err
    body = request.json or {}
    number = clean(body.get("number"), 12)
    if not number:
        return jsonify(error="Podaj numer domu"), 400

    codes = []
    for c in (body.get("codes") or [])[:MAX_CODES_PER_HOUSE]:
        value = clean(c.get("value"), MAX_CODE)
        if value:
            codes.append({"id": new_id("k"), "label": clean(c.get("label"), MAX_LABEL), "value": value})

    with _data_lock:
        data = load_data()
        street = find(data, street_id=sid)
        if not street:
            return jsonify(error="Nie znaleziono ulicy"), 404
        house = {"id": new_id("h"), "number": number, "codes": codes,
                 "note": clean(body.get("note"), MAX_NOTE), "updated": int(time.time())}
        street["houses"].append(house)
        street["houses"].sort(key=house_sort_key)
        save_data(data)

    log("house_add", house["id"], f'{street["name"]} {number}')
    for _ in codes:
        log("code_add", house["id"])
    if house["note"]:
        log("note_set", house["id"])
    return jsonify(house), 201


@app.patch("/api/houses/<hid>")
def edit_house(hid):
    role, err = require()
    if err:
        return err
    is_admin = role == "admin"
    body = request.json or {}
    events = []

    with _data_lock:
        data = load_data()
        house = find(data, house_id=hid)
        if not house:
            return jsonify(error="Nie znaleziono domu"), 404
        if "number" in body and not is_admin:
            return jsonify(error="Numer domu zmienia administrator"), 403

        if "note" in body:
            note = clean(body["note"], MAX_NOTE)
            if note != house["note"]:
                house["note"] = note
                events.append("note_set" if note else "note_clear")
        if "number" in body and is_admin:
            number = clean(body["number"], 12)
            if not number:
                return jsonify(error="Numer domu nie może być pusty"), 400
            house["number"] = number
        if events:
            house["updated"] = int(time.time())
        save_data(data)

    for action in events:
        log(action, hid)
    return jsonify(house)


@app.delete("/api/houses/<hid>")
def del_house(hid):
    _, err = require("admin")
    if err:
        return err
    with _data_lock:
        data = load_data()
        for city in data["cities"]:
            for street in city["streets"]:
                target = next((h for h in street["houses"] if h["id"] == hid), None)
                if target:
                    street["houses"].remove(target)
                    save_data(data)
                    log("house_del", hid, f'{street["name"]} {target["number"]}')
                    return jsonify(ok=True)
    return jsonify(error="Nie znaleziono domu"), 404


# --- коды --------------------------------------------------------------------
@app.post("/api/houses/<hid>/codes")
def add_code(hid):
    _, err = require()                    # код добавляет любой сотрудник
    if err:
        return err
    body = request.json or {}
    value = clean(body.get("value"), MAX_CODE)
    label = clean(body.get("label"), MAX_LABEL)
    if not value:
        return jsonify(error="Podaj kod"), 400

    with _data_lock:
        data = load_data()
        house = find(data, house_id=hid)
        if not house:
            return jsonify(error="Nie znaleziono domu"), 404
        if len(house["codes"]) >= MAX_CODES_PER_HOUSE:
            return jsonify(error=f"Maksymalnie {MAX_CODES_PER_HOUSE} kodów na dom"), 409
        if any(c["value"] == value and c["label"].lower() == label.lower() for c in house["codes"]):
            return jsonify(error="Taki kod już jest"), 409
        code = {"id": new_id("k"), "label": label, "value": value}
        house["codes"].append(code)
        house["updated"] = int(time.time())
        save_data(data)
    log("code_add", hid, f'{label} {value}'.strip())
    return jsonify(code), 201


@app.patch("/api/codes/<kid>")
def edit_code(kid):
    _, err = require("admin")             # править чужой код — только админ
    if err:
        return err
    body = request.json or {}
    with _data_lock:
        data = load_data()
        house, code = find_code(data, kid)
        if not code:
            return jsonify(error="Nie znaleziono kodu"), 404
        if "value" in body:
            value = clean(body["value"], MAX_CODE)
            if not value:
                return jsonify(error="Kod nie może być pusty"), 400
            code["value"] = value
        if "label" in body:
            code["label"] = clean(body["label"], MAX_LABEL)
        house["updated"] = int(time.time())
        save_data(data)
    log("code_edit", kid, f'{code["label"]} {code["value"]}'.strip())
    return jsonify(code)


@app.delete("/api/codes/<kid>")
def del_code(kid):
    _, err = require("admin")
    if err:
        return err
    with _data_lock:
        data = load_data()
        house, code = find_code(data, kid)
        if not code:
            return jsonify(error="Nie znaleziono kodu"), 404
        house["codes"].remove(code)
        house["updated"] = int(time.time())
        save_data(data)
    log("code_del", kid, f'{code["label"]} {code["value"]}'.strip())
    return jsonify(ok=True)


if __name__ == "__main__":
    load_auth()
    load_sessions()
    load_data()
    port = int(os.environ.get("PORT", 8000))
    print(f"Otwórz http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
