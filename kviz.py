#!/usr/bin/env python3
"""Kviz sa pamćenjem grešaka (Leitner kutije) za teorijski ispit B.

  kviz.py daj N [--oblast BR] [--nova] [--ponavljanje]   sledećih N pitanja (prvo dospela ponavljanja, pa nova)
  kviz.py odg "1:A 2:BC 3:C"                              oceni odgovore na poslednju turu (redni broj:slova)
  kviz.py stanje                                          ispiše i upiše Napredak.md + Greske.md
  kviz.py ispit                                           simulacija: 41 pitanje, meri bodove kao na ispitu

Podešavanja (promenljive okruženja):
  KVIZ_ISPIT=2026-11-20   datum ispita → odbrojavanje i plan po danima (bez njega plan traje 14 dana)
  KVIZ_PODACI=folder      folder sa pitanja.json, slike/ i napredak.json (podrazumevano: pored koda)

Kutije: 0 novo · 1 pogrešeno (ponovo danas/sutra) · 2 → za 1 dan · 3 → za 2 dana · 4 → za 4 dana · 5 = savladano.
Tačno iz prve (novo pitanje) ide pravo u kutiju 3; pogrešno uvek vraća u kutiju 1.
"""
import datetime as dt, json, os, pathlib, random, sys

KOD = pathlib.Path(__file__).resolve().parent
V = (KOD / os.environ.get("KVIZ_PODACI", ".")).resolve()  # pitanja.json, slike/, napredak.json
if not (V / "pitanja.json").exists():
    sys.exit(f"Nema {V / 'pitanja.json'} — vidi README (odeljak „Pitanja“).")
_SVA = json.loads((V / "pitanja.json").read_text())
Q = {q["id"]: q for q in _SVA}
PORTAL = {q["id"]: i for i, q in enumerate(_SVA)}
NP = V / "napredak.json"
st = json.loads(NP.read_text()) if NP.exists() else {"pitanja": {}, "tura": [], "dnevnik": []}
DANAS = dt.date.today()
INTERVAL = {1: 0, 2: 1, 3: 2, 4: 4, 5: 7}
# Kvote po oblasti na ispitu, izmerene iz 12 simulacija na portalu 26. sep 2026 (uvek iste, 41 pitanje, 98–99 bodova).
# Oblast 14 (Posledice nepoštovanja propisa, 142 pitanja) se NE pojavljuje na ispitu.
KVOTA = {6: 18, 8: 13, 10: 2, 5: 2, 11: 1, 4: 1, 12: 1, 9: 1, 1: 1, 2: 1}
# Datum ispita (KVIZ_ISPIT); dan pred ispit se ponavljaju samo slaba pitanja i radi se simulacija
ISPIT = dt.date.fromisoformat(os.environ["KVIZ_ISPIT"]) if os.environ.get("KVIZ_ISPIT") else None
DAN_PRED_ISPIT = ISPIT - dt.timedelta(days=1) if ISPIT else None


def pred_ispit():
    return DAN_PRED_ISPIT is not None and DANAS >= DAN_PRED_ISPIT


# Redosled novih pitanja: redom po lekcijama kao na portalu, bez preskakanja.
REDOSLED = sorted({q["oblast_br"] for q in _SVA})
# Dan pred ispit: prvo najveća vrednost po pitanju — Dozvole (2 na ispitu/35), Dužnosti (1/22),
# pa Signalizacija (13/471), pa ostatak Pravila (18/633); Posledice (0 na ispitu) poslednje
if pred_ispit():
    _PRVO = [1, 2, 4, 5, 10, 11, 8, 6, 9, 12, 14]
    REDOSLED = [o for o in _PRVO if o in REDOSLED] + [o for o in REDOSLED if o not in _PRVO]
L = "ABCDEFG"


def ucitaj():
    """Ponovo pročitaj napredak sa diska (server i CLI dele isti fajl)."""
    global st, DANAS
    st = json.loads(NP.read_text()) if NP.exists() else {"pitanja": {}, "tura": [], "dnevnik": []}
    DANAS = dt.date.today()


def p(qid):
    return st["pitanja"].setdefault(str(qid), {"kutija": 0, "tacno": 0, "netacno": 0, "sledece": None, "istorija": []})


def sacuvaj():
    NP.write_text(json.dumps(st, ensure_ascii=False, indent=1))


def dospela(razmak_min=10):
    # greška se vraća tek posle ~10 min (ne odmah u sledećoj turi) — bolje se pamti
    granica = (dt.datetime.now() - dt.timedelta(minutes=razmak_min)).isoformat(timespec="seconds")
    out = [((v["kutija"], -Q[int(k)]["bodova"]), k) for k, v in st["pitanja"].items()
           if 1 <= v["kutija"] <= 4 and v["sledece"] and v["sledece"] <= DANAS.isoformat()
           and v.get("zadnje", "") <= granica]
    return [int(k) for _, k in sorted(out)]


def nova(oblast=None):
    # redosled lekcija kao na portalu = redosled u pitanja.json
    red = sorted(Q.values(), key=lambda q: (REDOSLED.index(q["oblast_br"]) if q["oblast_br"] in REDOSLED else 99, PORTAL[q["id"]]))
    return [q["id"] for q in red if p(q["id"])["kutija"] == 0 and not p(q["id"])["istorija"] and (oblast is None or q["oblast_br"] == oblast)]


def prikazi(ids):
    tura = []
    for i, qid in enumerate(ids, 1):
        q = Q[qid]
        odg = q["odgovori"][:]
        random.shuffle(odg)
        tura.append({"id": qid, "slova": {L[j]: o["id"] for j, o in enumerate(odg)}})
        n = q["treba_zaokruziti"]
        print(f"\n**{i}.** {q['tekst']}  _({q['bodova']} bod. · zaokruži {n})_")
        if q["slika"]:
            print(f"   [slika: {V / q['slika']}]")
        for j, o in enumerate(odg):
            print(f"   {L[j]}) {o['tekst']}")
    st["tura"] = tura
    sacuvaj()


def daj(n, oblast=None, samo_nova=False, samo_pon=False):
    ids = sledeca(n, oblast, samo_nova, samo_pon)
    if not ids:
        print("Nema ničega za sada.")
        return
    prikazi(ids)


def oceni(qid, izabrani, zapis, nesiguran=False):
    """Oceni jedno pitanje; izabrani = skup id-jeva odgovora. Vraća True/False. Ne čuva na disk.
    nesiguran=True: tačno ali pogađao → kutija 2 (vraća se sutra), zapis sa „?"."""
    q = Q[qid]
    tacni = {o["id"] for o in q["odgovori"] if o["tacno"]}
    ok = set(izabrani) == tacni
    s = p(qid)
    bila_nova = not s["istorija"]
    s["istorija"].append([DANAS.isoformat(), "T" if ok else "N", ("? " if nesiguran else "") + zapis])
    s["zadnje"] = dt.datetime.now().isoformat(timespec="seconds")
    if ok:
        s["tacno"] += 1
        s["kutija"] = 2 if nesiguran else (3 if bila_nova else min(5, s["kutija"] + 1))
    else:
        s["netacno"] += 1
        s["kutija"] = 1
    s["sledece"] = (DANAS + dt.timedelta(days=INTERVAL[s["kutija"]])).isoformat()
    return ok


def sledeca(n, oblast=None, samo_nova=False, samo_pon=False):
    ids = [] if samo_nova else [i for i in dospela() if oblast is None or Q[i]["oblast_br"] == oblast]
    if pred_ispit() and not samo_pon:
        # dan pred ispit: ponavljaj samo slabe (kutija 1–2); dobro naučena (3–4) ne troše vreme novom gradivu
        ids = [i for i in ids if st["pitanja"][str(i)]["kutija"] <= 2]
    if not samo_pon:
        ids += nova(oblast)
    return ids[:n]


def odg(txt):
    tura = st["tura"]
    rez, bod, maxb = [], 0, 0
    for tok in txt.replace(",", " ").split():
        br, slova = tok.split(":")
        t = tura[int(br) - 1]
        q = Q[t["id"]]
        tacni = {o["id"] for o in q["odgovori"] if o["tacno"]}
        ok = oceni(q["id"], {t["slova"][s] for s in slova.upper() if s in t["slova"]}, slova.upper())
        maxb += q["bodova"]
        bod += q["bodova"] if ok else 0
        tacna_slova = "".join(sorted(k for k, v in t["slova"].items() if v in tacni))
        rez.append((br, ok, q, tacna_slova, t))
    st["dnevnik"].append([dt.datetime.now().isoformat(timespec="minutes"), len(rez), sum(r[1] for r in rez), bod, maxb])
    sacuvaj()
    for br, ok, q, ts, t in rez:
        if ok:
            print(f"{br}. ✅")
        else:
            tekst = " / ".join(o["tekst"] for o in q["odgovori"] if o["tacno"])
            print(f"{br}. ❌ tačno: {ts} — {tekst}")
    print(f"\nTura: {sum(r[1] for r in rez)}/{len(rez)} tačno · {bod}/{maxb} bodova ({100 * bod // max(maxb, 1)}%)")
    pregled()


def plan():
    """(početak, kraj) plana učenja: od prvog odgovora do dana pred ispit; bez datuma ispita 14 dana."""
    dani = [v["istorija"][0][0] for v in st["pitanja"].values() if v["istorija"]]
    od = dt.date.fromisoformat(min(dani)) if dani else DANAS
    return od, max(DAN_PRED_ISPIT if ISPIT else od + dt.timedelta(days=14), od)


def pregled_podaci():
    """Brojke za pregled posle svake ture."""
    d = DANAS.isoformat()
    prvo = {k: v["istorija"][0][0] for k, v in st["pitanja"].items() if v["istorija"]}
    pre_danas = sum(1 for x in prvo.values() if x < d)
    danas_novih = sum(1 for x in prvo.values() if x == d)
    # zaostatak se ravnomerno deli na preostale dane plana (ne gomila se sve na danas)
    dana_ostalo = max((plan()[1] - DANAS).days, 1)
    cilj_danas = -(-(len(Q) - pre_danas) // dana_ostalo)
    if pred_ispit():  # realan cilj za poslednji dan: Dozvole + Dužnosti + Signalizacija
        cilj_danas = danas_novih + sum(1 for q in Q.values() if q["oblast_br"] in (10, 11, 8) and not st["pitanja"].get(str(q["id"]), {}).get("istorija"))
    odg_danas = [h[1] for v in st["pitanja"].values() for h in v["istorija"] if h[0] == d]
    odg_sve = [h[1] for v in st["pitanja"].values() for h in v["istorija"]]
    return {"danas_novih": danas_novih, "cilj_danas": cilj_danas, "ostalo_danas": max(cilj_danas - danas_novih, 0),
            "ponavljanja": len([i for i in dospela(0) if not pred_ispit() or st["pitanja"][str(i)]["kutija"] <= 2]), "vidjeno": pre_danas + danas_novih, "ukupno": len(Q),
            "tacno_danas": odg_danas.count("T"), "odg_danas": len(odg_danas),
            "tacno_sve": odg_sve.count("T"), "odg_sve": len(odg_sve),
            "pogresnih": sum(1 for v in st["pitanja"].values() if v["kutija"] == 1), "dana_ostalo": dana_ostalo}


def pregled():
    x = pregled_podaci()
    pct = lambda a, b: 100 * a // max(b, 1)
    print("\n📊 PREGLED")
    print(f"Danas: {x['danas_novih']}/{x['cilj_danas']} novih ({pct(x['danas_novih'], x['cilj_danas'])}%) · ostalo još {x['ostalo_danas']}"
          + (f" · + {x['ponavljanja']} ponavljanja" if x["ponavljanja"] else ""))
    print(f"Ukupno: {x['vidjeno']}/{x['ukupno']} viđeno ({100 * x['vidjeno'] / x['ukupno']:.1f}%) · ostalo {x['ukupno'] - x['vidjeno']} ({100 * (x['ukupno'] - x['vidjeno']) / x['ukupno']:.1f}%)")
    print(f"Tačnost danas: {x['tacno_danas']} ✅ / {x['odg_danas'] - x['tacno_danas']} ❌ ({pct(x['tacno_danas'], x['odg_danas'])}%) · "
          f"ukupno: {x['tacno_sve']} ✅ / {x['odg_sve'] - x['tacno_sve']} ❌ ({pct(x['tacno_sve'], x['odg_sve'])}%)")


def stanje(ispis=True):
    ob = {}
    for q in Q.values():
        s = p(q["id"])
        o = ob.setdefault(q["oblast"], [0, 0, 0, 0])
        o[0] += 1
        o[1] += bool(s["istorija"])
        o[2] += s["kutija"] >= 3
        o[3] += s["kutija"] == 1
    vidjeno = sum(v[1] for v in ob.values())
    sigurno = sum(v[2] for v in ob.values())
    lose = sum(v[3] for v in ob.values())
    rok = plan()[1]  # poslednji dan: samo simulacije
    ostalo = sum(1 for q in Q.values() if not p(q["id"])["istorija"])
    dana = max((rok - DANAS).days, 1)
    md = [f"---\nazurirano: {DANAS}\n---\n", "# Napredak\n",
          f"Viđeno **{vidjeno}/{len(Q)}** · sigurno (kutija ≥3) **{sigurno}** · trenutno pogrešnih **{lose}** · dospelo za ponavljanje danas **{len(dospela())}**\n",
          f"Do simulacija ({rok.day}. {rok.month}.): {dana} dana → treba ~**{-(-ostalo // dana)} novih pitanja dnevno** (poslednji dan samo simulacije).\n",
          "| Oblast | Ukupno | Viđeno | Sigurno | Pogrešno |", "|---|---|---|---|---|"]
    for k, v in sorted(ob.items(), key=lambda x: -x[1][0]):
        md.append(f"| {k} | {v[0]} | {v[1]} | {v[2]} | {v[3]} |")
    md.append("\n## Ture\n")
    for d in st["dnevnik"][-15:]:
        md.append(f"- {d[0]}: {d[2]}/{d[1]} tačno, {d[3]}/{d[4]} bod.")
    (V / "Napredak.md").write_text("\n".join(md) + "\n\nVidi i [[Greske]]\n")

    g = ["# Greške — pitanja koja trenutno ne znaš\n", "Ovde stoje dok ih ne pogodiš ponovo. Tačni odgovori su označeni.\n"]
    for k, v in sorted(st["pitanja"].items(), key=lambda x: -x[1]["netacno"]):
        if v["kutija"] == 1:
            q = Q[int(k)]
            g.append(f"\n### {q['tekst']}\n_{q['oblast']} · {q['bodova']} bod. · pogrešeno {v['netacno']}×_\n")
            if q["slika"]:
                g.append(f"![[{pathlib.Path(q['slika']).name}|350]]\n")
            g += [f"- [{'x' if o['tacno'] else ' '}] {o['tekst']}" for o in q["odgovori"]]
    (V / "Greske.md").write_text("\n".join(g) + "\n")
    if ispis:
        print("\n".join(md[2:]))


def ispit():
    # 41 pitanje po istim kvotama kao pravi ispit (KVOTA)
    rnd = random.Random()
    ids = []
    for ob_, n in KVOTA.items():
        sve = [q["id"] for q in Q.values() if q["oblast_br"] == ob_]
        ids += rnd.sample(sve, min(n, len(sve)))
    prikazi(ids)


if __name__ == "__main__":
    a = sys.argv[1:]
    cmd = a[0] if a else "stanje"
    ob = int(a[a.index("--oblast") + 1]) if "--oblast" in a else None
    if cmd == "daj":
        daj(int(a[1]) if len(a) > 1 and a[1].isdigit() else 10, ob, "--nova" in a, "--ponavljanje" in a)
    elif cmd == "odg":
        odg(a[1])
    elif cmd == "ispit":
        ispit()
    else:
        stanje()
