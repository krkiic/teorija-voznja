#!/usr/bin/env python3
"""Pravi pitanja.json i slike/ od pitanja preuzetih sa iso.euprava.gov.rs (vežbanje, kategorija B).

  python3 napravi_pitanja.py [pitanja_raw.json] [--beleske]

Ulaz:  izvoz sa portala (cats -> subs -> qs, vidi README), podrazumevano pitanja_raw.json pored skripte
Izlaz: pitanja.json (čisto), slike/<qId>.jpg; sa --beleske i Obsidian beleške Oblasti/<nn Oblast>/<Podoblast>.md, Oblasti.md
Napredak (napredak.json) se NE dira.
"""
import base64, json, re, pathlib, sys

V = pathlib.Path(__file__).resolve().parent
arg = [a for a in sys.argv[1:] if not a.startswith("--")]
BELESKE = "--beleske" in sys.argv
raw = json.loads(pathlib.Path(arg[0] if arg else V / "pitanja_raw.json").read_text())

CYR = dict(zip("абвгдђежзијклљмнњопрстћуфхцчџшАБВГДЂЕЖЗИЈКЛЉМНЊОПРСТЋУФХЦЧЏШ",
               ["a","b","v","g","d","đ","e","ž","z","i","j","k","l","lj","m","n","nj","o","p","r","s","t","ć","u","f","h","c","č","dž","š",
                "A","B","V","G","D","Đ","E","Ž","Z","I","J","K","L","Lj","M","N","Nj","O","P","R","S","T","Ć","U","F","H","C","Č","Dž","Š"]))
def lat(s): return "".join(CYR.get(ch, ch) for ch in (s or "")).replace("ј", "j").replace("њ", "nj").replace("љ", "lj")
def clean(s): return re.sub(r"\s+", " ", lat(s)).strip()
def fname(s, n=80): return re.sub(r'[\\/:*?"<>|#^\[\]]', "", clean(s)).strip(" ;.")[:n].strip()

(V / "slike").mkdir(exist_ok=True)
out, idx = [], ["# Oblasti\n", "Sva pitanja za teorijski ispit, kategorija B (izvor: iso.euprava.gov.rs, vežbanje).\n"]
for ci, c in enumerate(raw["cats"], 1):
    cname = fname(c["name"])
    cdir = V / "Oblasti" / f"{ci:02d} {cname}"
    total = sum(len(s["qs"]) for s in c["subs"])
    if not total:
        continue
    if BELESKE:
        cdir.mkdir(parents=True, exist_ok=True)
    idx.append(f"\n## {ci:02d} {cname} — {total} pitanja\n")
    for s in c["subs"]:
        if not s["qs"]:
            continue
        sname = fname(s["name"])
        lines = [f"---\noblast: \"{cname}\"\npodoblast: \"{clean(s['name'])}\"\npitanja: {len(s['qs'])}\n---\n",
                 f"# {clean(s['name'])}\n", f"Oblast: [[Oblasti|{cname}]]\n"]
        for q in s["qs"]:
            img = None
            if q.get("image"):
                b64 = q["image"].split(",", 1)[-1]
                img = f"{q['qId']}.jpg"
                (V / "slike" / img).write_bytes(base64.b64decode(b64))
            choices = [{"id": ch["paId"], "tekst": clean(ch["text"]), "tacno": bool(ch["correct"])} for ch in q["choices"]]
            out.append({"id": q["qId"], "oblast": cname, "oblast_br": ci, "podoblast": clean(s["name"]),
                        "tekst": clean(q["text"]), "bodova": q.get("points"), "treba_zaokruziti": q.get("choicesReq"),
                        "slika": f"slike/{img}" if img else None, "odgovori": choices,
                        "objasnjenje": clean(q.get("explanation")) or None})
            lines.append(f"\n### {q['qId']} · {q.get('points')} bod. · zaokruži {q.get('choicesReq')}\n")
            lines.append(clean(q["text"]) + "\n")
            if img:
                lines.append(f"\n![[{img}|400]]\n")
            for ch in choices:
                lines.append(f"- [{'x' if ch['tacno'] else ' '}] {ch['tekst']}")
            lines.append("")
        if BELESKE:
            (cdir / f"{sname}.md").write_text("\n".join(lines))
        idx.append(f"- [[{sname}]] — {len(s['qs'])}")

(V / "pitanja.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
if BELESKE:
    (V / "Oblasti.md").write_text("\n".join(idx) + "\n")
print(f"{len(out)} pitanja, {sum(1 for q in out if q['slika'])} slika, "
      f"{sum(q['bodova'] or 0 for q in out)} bodova ukupno")
