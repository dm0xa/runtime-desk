# dm0xa/homebrew-tap

```sh
brew install --cask dm0xa/tap/runtime-desk
```

[Runtime Desk](https://github.com/dm0xa/runtime-desk) — one window over Colima, Docker and Podman.

`Casks/runtime-desk.rb` is generated: `bump.sh` reads the newest release's
`SHA256SUMS.txt` and rewrites version, urls and both checksums, on a daily
schedule and whenever a release dispatches it. Edit `bump.sh` in the app
repository's `packaging/homebrew/` directory, never the cask here.
