# Homebrew cask

The cask is generated, never hand-edited, because a cask's `sha256` only exists
once the release asset does — and releases in `dm0xa/runtime-desk` are immutable,
so a checksum cannot be added to one afterwards.

- `bump.sh` renders `Casks/runtime-desk.rb` from the newest release's
  `SHA256SUMS.txt` (one line per architecture). It is the single source of the
  cask text: change the app, the bundle id or the zap paths here, not in the tap.
- `.github/workflows/bump.yml` is the tap's daily bump: it runs `bump.sh`, commits
  only when the cask actually moved, and prints `cask already names the newest
  release` on a no-op run.
- `.github/release.yml`-side wiring: `.github/workflows/release.yml` in the app
  repo attaches `SHA256SUMS.txt` to every release and dispatches the bump
  workflow when a `TAP_TOKEN` secret exists.

## Setting up the tap

`brew install --cask dm0xa/tap/runtime-desk` maps tap `dm0xa/tap` to the
repository `dm0xa/homebrew-tap`, so the tap is a separate repository:

```sh
gh repo create dm0xa/homebrew-tap --private
git clone https://github.com/dm0xa/homebrew-tap /tmp/homebrew-tap
cp packaging/homebrew/bump.sh /tmp/homebrew-tap/
mkdir -p /tmp/homebrew-tap/.github/workflows
cp packaging/homebrew/.github/workflows/bump.yml /tmp/homebrew-tap/.github/workflows/
cp packaging/homebrew/tap-README.md /tmp/homebrew-tap/README.md
cd /tmp/homebrew-tap && chmod +x bump.sh && git add -A && git commit -m 'cask machinery'
```

Then, once a release exists:

```sh
./bump.sh                       # writes Casks/runtime-desk.rb
git add Casks && git commit -m 'runtime-desk: first cask'
```

`bump.sh` needs `gh` authenticated against the app repository, which is private:
store a fine-grained token with **Contents: read** on `dm0xa/runtime-desk` as the
tap's `RELEASE_TOKEN` secret, and the same token with **Actions: write** on
`dm0xa/homebrew-tap` as `TAP_TOKEN` in the app repository so a release dispatches
the bump immediately.

## Verifying a cask before publishing

```sh
brew tap --force dm0xa/tap /path/to/tap-checkout
brew trust --cask dm0xa/tap/runtime-desk
brew audit --cask dm0xa/tap/runtime-desk     # exit 0, no output
brew style Casks/runtime-desk.rb             # from the tap checkout; no offenses
brew install --cask dm0xa/tap/runtime-desk --appdir=/tmp/casktest
brew uninstall --cask --force runtime-desk   # uninstall takes no --appdir
brew untap dm0xa/tap
```

`--appdir` keeps `/Applications` untouched. `brew audit --online` additionally
downloads the asset to check the `sha256`; it needs the release to be public.
Style the cask, not the tap root: `brew style --cask dm0xa/tap` also lints
`bump.sh`, which Homebrew's bash-oriented shellcheck reads as `[[ ]]`/brace
offenses against a deliberately POSIX script.
