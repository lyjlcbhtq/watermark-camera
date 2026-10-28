# Vendored hashing dependency

- Package: `@noble/hashes`
- Version: `2.0.1`
- Source: https://www.npmjs.com/package/@noble/hashes/v/2.0.1
- Upstream: https://github.com/paulmillr/noble-hashes
- License: MIT; see `LICENSE` in this directory.
- Retrieved with `npm pack @noble/hashes@2.0.1`.

Only the unmodified runtime files needed by `sha2.js` are included: `sha2.js`,
`_md.js`, `_u64.js`, and `utils.js`. The app uses SHA-256 incrementally in a
dedicated worker to avoid reading a complete recording into memory at once.
The local hash does not provide a trusted timestamp, signature, or proof of origin.
