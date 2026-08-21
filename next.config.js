const { display } = require('./scripts/product-name.js');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // The screens are not allowed to type the product's name: it is read out of
  // `server/src/identity.rs` at build time and inlined here, so a rename is
  // still one edit in one file (bw-8um.3.16).
  env: {
    NEXT_PUBLIC_PRODUCT_NAME: display,
  },
  images: {
    unoptimized: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
