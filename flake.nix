{
  description = "prediff — fast local agent-first diff review tool";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          # Packaging choice: a thin wrapper around `bun <store>/src/cli/index.ts`
          # rather than `bun build --compile`. The compiled-binary route breaks
          # two runtime assumptions with no offsetting benefit here:
          #   1. `prediff open` re-spawns `process.execPath <src>/server/daemon.ts`
          #      to detach the daemon; in a compiled binary execPath is the binary
          #      itself and the embedded entry can't execute an external script.
          #   2. The daemon serves the prebuilt UI from `public/` on disk via
          #      `import.meta.dir`; --compile does not embed those assets.
          # The wrapper keeps both working: `import.meta.dir` resolves inside the
          # store copy, and `process.execPath` is the nix-store bun. The backend
          # has zero runtime npm dependencies, so no node_modules is needed.
          prediff = pkgs.stdenvNoCC.mkDerivation {
            pname = "prediff";
            version = "0.1.0";
            src = ./.;

            nativeBuildInputs = [ pkgs.makeWrapper ];

            dontConfigure = true;
            dontBuild = true;

            installPhase = ''
              runHook preInstall
              mkdir -p $out/share/prediff $out/bin
              cp -r src public package.json tsconfig.json $out/share/prediff/
              makeWrapper ${pkgs.bun}/bin/bun $out/bin/prediff \
                --add-flags "$out/share/prediff/src/cli/index.ts" \
                --suffix PATH : ${pkgs.git}/bin
              runHook postInstall
            '';

            meta = {
              description = "Fast local agent-first diff review tool";
              homepage = "https://github.com/alexdrydew/prediff";
              mainProgram = "prediff";
            };
          };
        in
        {
          inherit prediff;
          default = prediff;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/prediff";
          meta.description = "Fast local agent-first diff review tool";
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [ pkgs.bun ];
          };
        }
      );

      # Lightweight smoke check only: `prediff help` must exit 0 and print usage.
      # The full `bun test` suite spawns daemons and git repos and is not
      # sandbox-friendly; run it with `bun test` outside nix.
      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          cli-help = pkgs.runCommand "prediff-cli-help" { } ''
            export HOME=$TMPDIR
            ${self.packages.${system}.default}/bin/prediff help > $out
            grep -q "usage: prediff" $out
          '';
        }
      );
    };
}
