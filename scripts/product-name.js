/**
 * What the product is called, read from the one place it is written down.
 *
 * `server/src/identity.rs` defines the name once. Everything else in the tree
 * is meant to derive from it rather than type it a second time, because a
 * rename that only reaches the places somebody remembered leaves the product
 * answering to two names (bw-8um.3.8, bw-8um.3.16).
 *
 * The frontend cannot read a Rust constant at runtime, so the build reads it
 * here and hands it to the screens as a compile-time value: `next.config.js`
 * for the real build, `vitest.config.ts` for the tests. Both go through this
 * one function, so there is still exactly one spelling in the tree.
 */
const fs = require('fs');
const path = require('path');

const IDENTITY = path.join(__dirname, '..', 'server', 'src', 'identity.rs');

function read(constant) {
  const text = fs.readFileSync(IDENTITY, 'utf8');
  const found = text.match(
    new RegExp(`pub const ${constant}: &str = "([^"]+)";`)
  );
  if (!found) {
    throw new Error(
      `server/src/identity.rs defines no ${constant}, so the screens have no name to carry`
    );
  }
  return found[1];
}

/** The name as a command line and a package manager spell it. */
const name = read('NAME');

/** The same name as a person reads it, on a screen or in a browser tab. */
const display = read('DISPLAY');

module.exports = { name, display };
