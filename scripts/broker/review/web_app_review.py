#!/usr/bin/env python3
"""Drive the served Flutter web app in a HEADFUL browser (run under xvfb-run) and emit a JSON verdict.

Usage (normally via web-review.sh, which supplies the virtual display):
    xvfb-run -a python3 web_app_review.py <app_url> <screenshot_path>

Headful + a real (virtual) display is what makes Flutter's CanvasKit/WebGL canvas actually paint —
headless Chrome in this WSL2 container wedges the compositor, headful-under-xvfb does not.
Prints one JSON line prefixed `VERDICT:` and exits 0 on pass, 1 on fail.
"""
import json, sys

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:37734/cosy/"
SHOT = sys.argv[2] if len(sys.argv) > 2 else "web-app-review.png"
ARGS = ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900"]

try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    print("VERDICT:" + json.dumps({"pass": False, "error": "playwright import: " + str(e)})); sys.exit(1)

res = {"url": URL, "console_errors": [], "page_errors": [], "bad_responses": []}
with sync_playwright() as p:
    br = None
    for chan in ("chromium", "chrome"):
        try:
            br = p.chromium.launch(channel=chan, headless=False, args=ARGS); res["channel"] = chan; break
        except Exception as e:
            res["launch_" + chan] = str(e)[:140]
    if br is None:
        print("VERDICT:" + json.dumps({**res, "pass": False, "error": "no chromium channel launched"})); sys.exit(1)

    pg = br.new_page(viewport={"width": 1280, "height": 900})
    pg.set_default_timeout(20000)
    res["api_requests"] = []
    pg.on("console", lambda m: res["console_errors"].append(m.text[:200]) if m.type == "error" else None)
    pg.on("pageerror", lambda e: res["page_errors"].append(str(e)[:200]))
    pg.on("response", lambda r: res["bad_responses"].append({"s": r.status, "u": r.url[:110]}) if r.status >= 400 else None)
    # Record the app's own calls to /api/* (the driver only ever calls /api/health itself). A GET to
    # /api/sessions therefore proves the app built a broker client and fetched the roster on its own —
    # i.e. the same-origin default AUTO-CONNECTED, independent of how many sessions the roster has.
    pg.on("request", lambda r: res["api_requests"].append(r.method + " " + r.url.split("://", 1)[-1].split("/", 1)[-1][:70])
          if "/api/" in r.url else None)

    try:
        pg.goto(URL, wait_until="domcontentloaded", timeout=25000); res["goto"] = "ok"
    except Exception as e:
        res["goto"] = "ERR:" + str(e)[:150]

    booted = False
    for _ in range(40):                       # up to ~20s for the engine to attach a view
        try: booted = pg.evaluate("()=>!!document.querySelector('flutter-view')")
        except Exception: booted = False
        if booted: break
        pg.wait_for_timeout(500)
    res["flutter_view"] = booted
    # Wait for the app to auto-connect and fetch its roster. The same-origin default hydrates
    # asynchronously (incl. IndexedDB writes on web), so the /api/sessions call can land several
    # seconds after first paint — a fixed short settle races it. Poll up to ~15s for the app's own
    # roster call, then a brief settle so the list paints for the screenshot.
    for _ in range(30):
        if any("api/sessions" in u for u in res["api_requests"]):
            break
        pg.wait_for_timeout(500)
    pg.wait_for_timeout(2000)

    def ev(name, expr):
        try: res[name] = pg.evaluate(expr)
        except Exception as e: res[name] = "ERR:" + str(e)[:120]
    ev("title", "()=>document.title")
    ev("origin", "()=>location.origin")
    ev("base_href", "()=>(document.querySelector('base')||{}).href||null")
    ev("webgl2", "()=>{try{return !!document.createElement('canvas').getContext('webgl2');}catch(e){return false;}}")
    ev("sab", "()=>typeof SharedArrayBuffer!=='undefined'")
    ev("same_origin_fetch",
       "async()=>{try{const r=await fetch('/api/health');return{status:r.status,ok:r.ok};}catch(e){return{error:String(e)};}}")
    try:
        pg.screenshot(path=SHOT, timeout=20000); res["screenshot"] = SHOT
    except Exception as e:
        res["screenshot"] = "ERR:" + str(e)[:150]
    br.close()

sof = res.get("same_origin_fetch") or {}
# Did the APP fetch the roster on its own? Proves the same-origin default auto-connected (built a client),
# not merely pre-selected a profile. (/api/sessions is never called by this driver — only the app calls it.)
res["app_fetched_roster"] = any("api/sessions" in u for u in res.get("api_requests", []))
res["pass"] = bool(res.get("flutter_view")
                   and res["app_fetched_roster"]
                   and isinstance(sof, dict) and sof.get("ok") is True
                   and not res["console_errors"] and not res["page_errors"]
                   and isinstance(res.get("screenshot"), str) and res["screenshot"].endswith(".png"))
print("VERDICT:" + json.dumps(res))
sys.exit(0 if res["pass"] else 1)
