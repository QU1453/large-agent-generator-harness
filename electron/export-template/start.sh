#!/usr/bin/env bash
cd "$(dirname "$0")"
python3 la_main.py --serve --port __PORT__
