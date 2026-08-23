{
  description = "Atelier";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };

          frontend = pkgs.buildNpmPackage {
            pname = "atelier-frontend";
            version = "0.14.0";
            src = ./.;

            nodejs = pkgs.nodejs_22;
            npmDepsHash = "sha256-mqzfb4fiJqrXpR0N9QZFT1niuouSJF9G6Q02Z/5KNGY=";

            env.NEXT_TELEMETRY_DISABLED = "1";

            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp -R out "$out/"
              runHook postInstall
            '';
          };
        in
        {
          default = pkgs.rustPlatform.buildRustPackage {
            pname = "atelier";
            version = "0.14.0";
            src = ./.;

            cargoLock.lockFile = ./server/Cargo.lock;
            cargoRoot = "server";
            buildAndTestSubdir = "server";

            postPatch = ''
              cp -R ${frontend}/out out
            '';

            nativeBuildInputs = [ pkgs.pkg-config ];
            buildInputs = [
              pkgs.openssl
              pkgs.zlib
            ];

            doCheck = false;

            installPhase = ''
              runHook preInstall
              binary="target/${pkgs.stdenv.hostPlatform.config}/release/atelier"
              if [ ! -x "$binary" ]; then
                binary="target/release/atelier"
              fi
              install -Dm755 "$binary" "$out/bin/atelier"
              runHook postInstall
            '';

            meta = {
              description = "Visual Kanban UI for Beads CLI";
              homepage = "https://github.com/AhsanSarwar45/atelier";
              mainProgram = "atelier";
            };
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              cargo
              clippy
              nodejs_22
              openssl
              pkg-config
              rustc
              rustfmt
              zlib
            ];

            env.NEXT_TELEMETRY_DISABLED = "1";
          };
        }
      );
    };
}
