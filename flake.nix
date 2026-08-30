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
            version = "0.21.2";
            src = ./.;

            nodejs = pkgs.nodejs_22;
            npmDepsHash = "sha256-/EeA49Gf0Q2m8ilAnHYmM0J44U732LApyOOHYmo8odY=";

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
            version = "0.21.2";
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
              # Carry a Node runtime one folder over in libexec, so the installed
              # program finds it by its own location with no Node on the reader's
              # PATH (bw-oesd.2). atelier in $out/bin canonicalizes to itself and
              # looks in ../libexec; a link into the immutable store is all that
              # placement needs.
              mkdir -p "$out/libexec"
              ln -s ${pkgs.nodejs_24}/bin/node "$out/libexec/node"
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
