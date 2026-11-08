# DRAFT for homebrew/homebrew-cask (Casks/c/coral.rb). Not submitted; the submission is the Operator's call (#11066).
# Not run through `brew audit --new --cask --online` or `brew style`: brew is not installed on the machines this was drafted on.
cask "coral" do
  version "2.0.59"
  sha256 "ed547844e8178f30ace503102768c42afcf8b79fd9309954b26e0c973a4c37fa"

  url "https://github.com/subgentic/coral/releases/download/v#{version}/Coral.v#{version}.dmg"
  name "Coral"
  desc "Multi-agent orchestration for AI coding agents"
  homepage "https://github.com/subgentic/coral"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :ventura

  app "Coral.app"

  uninstall quit: "com.coral.dashboard"

  zap trash: [
    "~/.coral",
    "~/Library/Caches/com.coral.dashboard",
    "~/Library/Preferences/com.coral.dashboard.plist",
    "~/Library/WebKit/com.coral.dashboard",
  ]

  caveats <<~EOS
    Coral bundles its own tmux; nothing else needs to be installed.

    The `coral`, `coral-board` and `coral-agent` command-line tools are not on
    your PATH by default. To add them:
      #{appdir}/Coral.app/Contents/MacOS/install-cli.sh
  EOS
end
