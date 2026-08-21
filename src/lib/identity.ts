/**
 * What the product is called, on the screens.
 *
 * The name is written down once, in `server/src/identity.rs`. The build reads
 * it from there (`scripts/product-name.js`) and inlines it, so no screen ever
 * types it a second time and a rename stays one edit in one file.
 *
 * Missing means the build forgot to hand it over, which would otherwise show
 * up as a blank browser tab nobody notices. It fails loudly instead.
 */
const fromBuild = process.env.NEXT_PUBLIC_PRODUCT_NAME;

if (!fromBuild) {
  throw new Error(
    'the build did not say what the product is called: NEXT_PUBLIC_PRODUCT_NAME is unset, ' +
      'which next.config.js and vitest.config.ts both fill in from server/src/identity.rs'
  );
}

/** The name a person reads — in the browser tab, and in the top bar. */
export const PRODUCT_NAME: string = fromBuild;
