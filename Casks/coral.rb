cask "coral" do
  version "2.0.67"
  sha256 "f31401db30afd08f852078c9ad850ec3671f18a6722e75ba24ee1f77e4fa05bb"

  url "https://github.com/subgentic/coral/releases/download/v#{version}/Coral.v#{version}.dmg"
  name "Coral"
  desc "Multi-agent orchestration system for AI coding agents"
  homepage "https://github.com/subgentic/coral"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "Coral.app"

  # The install-source marker Coral's updater reads (coral-go/internal/updater/install, #10561): written next to this version's staged files, outside the signed bundle, so a DMG copy that is put over
  # the cask's app later is told from the cask's own (it has no marker for its version, and the cask's records of an older version do not count for it).
  postflight do
    require "json"
    (staged_path/"install-source.json").write(JSON.generate({ "source" => "homebrew-cask", "app" => "#{appdir}/Coral.app", "version" => version.to_s }))
  end

  zap trash: "~/.coral"

  caveats <<~EOS
    Coral bundles its own tmux; nothing else needs to be installed.

    Launch Coral from your Applications folder or Spotlight.
    The dashboard runs at http://localhost:8420.

    The `coral`, `coral-board` and `coral-agent` command-line tools are not on
    your PATH by default. To add them:
      #{appdir}/Coral.app/Contents/MacOS/install-cli.sh
  EOS
end
