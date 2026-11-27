EXT_DIR  := extension
EXT_NAME := $(shell node -p "require('./$(EXT_DIR)/package.json').name")
EXT_VER  := $(shell node -p "require('./$(EXT_DIR)/package.json').version")
VSIX     := $(EXT_DIR)/$(EXT_NAME)-$(EXT_VER).vsix
DEPS     := $(EXT_DIR)/node_modules/.package-lock.json

.PHONY: all test package install clean

all: test package

test:
	npm test

$(DEPS): $(EXT_DIR)/package.json $(EXT_DIR)/package-lock.json
	cd $(EXT_DIR) && npm ci

package: $(DEPS)
	cd $(EXT_DIR) && npm run package

install: package
	@command -v code >/dev/null 2>&1 || { echo "make install: 'code' CLI not found on PATH; install $(VSIX) via Extensions > Install from VSIX..., or in VS Code run 'Shell Command: Install 'code' command in PATH'" >&2; exit 1; }
	code --install-extension $(VSIX)

clean:
	rm -f $(EXT_DIR)/$(EXT_NAME)-*.vsix
