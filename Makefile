.PHONY: build run clean

build:
	@hugo build

run:
	@hugo server --port 4000 --bind 127.0.0.1

clean:
	@rm -rf public/ resources/ .hugo_build.lock
