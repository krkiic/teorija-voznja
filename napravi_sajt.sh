#!/usr/bin/env bash
# Pravi statički sajt (GitHub Pages) u folderu $1 (podrazumevano _site).
# Jedini izvor istine za to šta se objavljuje: koriste ga i GitHub Actions i testovi.
# Kopira SAMO: app/index.html, app/kviz.js, pitanja.json i slike/ — nikad ceo koren repoa.
set -euo pipefail

KOREN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ZNAK=".napravi_sajt"                                          # znak da je folder napravila ova skripta (sme da se obriše)
LICNI=(napredak.json Napredak.md Greske.md pitanja_raw.json)  # lični fajlovi: nikad u sajtu

greska() { echo "napravi_sajt.sh: $*" >&2; exit 1; }

# fizička putanja i kad folder još ne postoji (bez realpath, radi i na macOS-u)
apsolutna() {
  local p=$1 ostatak=""
  [[ $p == /* ]] || p="$PWD/$p"
  while [[ ! -d $p ]]; do
    ostatak="/$(basename "$p")$ostatak"
    p="$(dirname "$p")"
  done
  case $ostatak in */..|*/../*) greska "putanja sa '..' kroz folder koji ne postoji: $1";; esac
  echo "$(cd "$p" && pwd -P)$ostatak"
}

IZLAZ="$(apsolutna "${1:-$KOREN/_site}")"   # podrazumevano _site u korenu repoa, iz kog god foldera da se skripta pozove

# zaštita: izlaz mora biti pod-folder repoa, a ne koren, izvorni folderi ni .git
[[ $IZLAZ != "$KOREN" ]] || greska "izlaz ne sme biti koren repoa: $IZLAZ"
[[ $IZLAZ == "$KOREN"/* ]] || greska "izlaz mora biti unutar repoa ($KOREN): $IZLAZ"
for zabranjen in app slike .git .github; do
  [[ $IZLAZ != "$KOREN/$zabranjen" && $IZLAZ != "$KOREN/$zabranjen"/* ]] || greska "izlaz ne sme biti u '$zabranjen': $IZLAZ"
done
# postojeći folder se briše samo ako je prazan ili ga je napravila ova skripta
if [[ -e $IZLAZ ]]; then
  [[ -d $IZLAZ ]] || greska "izlaz nije folder: $IZLAZ"
  if [[ -n "$(ls -A "$IZLAZ")" && ! -f "$IZLAZ/$ZNAK" ]]; then
    greska "folder nije prazan i nije napravljen ovom skriptom, ne diram ga: $IZLAZ"
  fi
fi

cd "$KOREN"
for f in app/index.html app/kviz.js pitanja.json slike; do
  [[ -e $f ]] || greska "nedostaje $f"
done
grep -q '<meta name="kviz-backend" content="static">' app/index.html \
  || greska 'app/index.html nema <meta name="kviz-backend" content="static">'
# u slike/ idu samo .jpg (skriveni fajlovi se preskaču); sve drugo je greška, ne tiho objavljivanje
strano="$(find slike -mindepth 1 ! -name '*.jpg' ! -name '.*' -print)"
[[ -z $strano ]] || greska "u slike/ ima fajlova koji nisu .jpg: $strano"
# simboličke veze se ne prate: veza na lični fajl bi ga objavila pod imenom slike
simveze="$(find app/index.html app/kviz.js pitanja.json slike -type l -print)"
[[ -z $simveze ]] || greska "simboličke veze nisu dozvoljene u izvoru sajta: $simveze"

rm -rf "$IZLAZ"
mkdir -p "$IZLAZ/slike"
: > "$IZLAZ/$ZNAK"
cp app/index.html "$IZLAZ/index.html"
cp app/kviz.js "$IZLAZ/kviz.js"
cp pitanja.json "$IZLAZ/pitanja.json"
cp slike/*.jpg "$IZLAZ/slike/"

# provera: samo dozvoljeni fajlovi i nijedan lični (ni u slike/, bez obzira na velika slova)
for f in "${LICNI[@]}"; do
  nadjen="$(find "$IZLAZ" -iname "$f" -print)"
  [[ -z $nadjen ]] || greska "lični fajl je dospeo u sajt: $nadjen"
done
for f in "$IZLAZ"/* "$IZLAZ"/.[!.]*; do
  [[ -e $f ]] || continue
  case $(basename "$f") in index.html|kviz.js|pitanja.json|slike|"$ZNAK") ;; *) greska "neočekivan fajl u sajtu: $f";; esac
done
[[ $(ls "$IZLAZ/slike" | wc -l) -eq $(ls slike/*.jpg | wc -l) ]] || greska "broj slika u sajtu se ne poklapa sa slike/"

echo "Sajt je spreman: $IZLAZ ($(ls "$IZLAZ/slike" | wc -l | tr -d ' ') slika, $(du -sh "$IZLAZ" | cut -f1))"
