#!/bin/zsh
# Dupli klik → otvara kviz u browseru. Zatvori ovaj prozor kad završiš.
cd "$(dirname "$0")"
# export KVIZ_ISPIT=2026-11-20   # datum tvog ispita: odbrojavanje i plan po danima
python3 server.py
