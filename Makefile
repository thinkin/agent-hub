.DEFAULT_GOAL := help

NPM ?= npm
PORT ?= 4317
ARGS ?=

.PHONY: help install dev build build-web start typecheck test test-browser check

help:
	@printf '%s\n' \
	  'make install       Install locked dependencies (npm ci)' \
	  'make dev           Run development server; opens no browser' \
	  'make build         Build CLI, backend and frontend' \
	  'make build-web     Update frontend assets only' \
	  'make start         Run built server and open browser' \
	  'make typecheck     Check backend and frontend types' \
	  'make test          Run unit and real-PTY integration tests' \
	  'make test-browser  Run Chrome end-to-end tests' \
	  'make check         Run type checks and non-browser tests' \
	  '' \
	  'Overrides: PORT=4318 ARGS="--no-open" NPM=npm' \
	  'Build before start. Targets do not stop or restart existing services.'

install:
	$(NPM) ci

dev:
	$(NPM) run dev -- --port $(PORT) $(ARGS)

build:
	$(NPM) run build

build-web:
	$(NPM) exec -- vite build

start:
	$(NPM) start -- --port $(PORT) $(ARGS)

typecheck:
	$(NPM) run typecheck

test:
	$(NPM) test

test-browser:
	$(NPM) run test:browser

check:
	$(NPM) run typecheck
	$(NPM) test
