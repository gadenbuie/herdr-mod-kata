# Render assets/preview.html to the repo-root preview.png:
# 1280×800 authored, 1.25× device scale, shipping at 1600×1000
# (the same recipe herdr-mod-plannotator's preview uses).
CHROME ?= /Applications/Google Chrome.app/Contents/MacOS/Google Chrome

# Where Herdr (0.1.12) looks for mods. It does not run a mod behind a
# symlink, so installing is a copy — tab-host watches mods/ and the
# Kata button appears the moment it lands.
DEST ?= $(HOME)/.config/herdr-app/mods/kata

.PHONY: preview
preview: preview.png

preview.png: assets/preview.html
	@test -x "$(CHROME)" || { echo "make: no Chrome at $(CHROME) (set CHROME=... to override)"; exit 1; }
	"$(CHROME)" \
	  --headless \
	  --screenshot=preview.png \
	  --window-size=1280,800 \
	  --force-device-scale-factor=1.25 \
	  --hide-scrollbars \
	  "file://$(CURDIR)/assets/preview.html" 2>/dev/null
	@sips -g pixelWidth -g pixelHeight preview.png | tail -2

.PHONY: install
install: | $(DEST)
	rsync -rlpt --delete mods/kata/ $(DEST)/
	herdr-app check $(DEST)

# Herdr ignores mods behind a symlink, so the destination must be a
# real folder; fail early rather than copy into one.
$(DEST):
	@test ! -L "$(patsubst %/,%,$(DEST))" \
	  || { echo "make: $(patsubst %/,%,$(DEST)) is a symlink; Herdr would not run it" >&2; exit 1; }
	@mkdir -p $(DEST)
