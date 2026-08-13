#!/usr/bin/env ruby
# frozen_string_literal: true

require 'digest'
require 'open3'
require 'pathname'
require_relative 'check-flutter-goldens'

ROOT = Pathname.new(__dir__).join('../..').cleanpath
Dir.chdir(ROOT)

ALLOWLIST_PATH = 'scripts/ci/public-binary-allowlist.sha256'
CONTENT_EXCEPTIONS_PATH = 'scripts/ci/public-content-exceptions.sha256'
WORKFLOW_MODE_PATH = '.github/workflow-mode'
MAX_TEXT_BYTES = 5 * 1024 * 1024
DENIED_COMPONENTS = %w[
  .agents .claude .codex .codeany .migration-private .worktrees
  _archive output screenshots thirdparty
].freeze
DENIED_BASENAMES = %w[AGENTS.md CLAUDE.md].freeze
DENIED_EXTENSIONS = %w[
  .7z .bak .crt .env .key .log .map .p12 .pem .pdf .sqlite .tar .tgz .zip
].freeze
WINDOWS_RESERVED = /\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?\z/i
DENIED_PERSONAL_COMPONENT_HASHES = %w[
  1934d8bfaed57f11f8af9175540fce4b2ff0492e6b258e73ae2f16bc8c339d4c
  522ce7057fd0523adcd6672db24bb671d09d1ffa2f1e7c97c13e6c68ae6fcb13
].freeze
ALWAYS_DENIED_TEXT = {
  'excluded internal documentation reference' => %r{docs/(?:04-tech|06-roadmap|07-guides|superpowers|20\d{6}[^/\s]*)/},
  'excluded archived-tree reference' => %r{_archive/}
}.freeze
# The internal documentation repository is a gitignored nested checkout. Its
# existence is legal, but tracked internal-docs content is always rejected.
INTERNAL_DOCS_ROOT = 'docs-internal'
# Literal synthetic tailnet hostnames the suites already use. Exact strings
# only: no wildcard here can admit a real MagicDNS name, which always has the
# shape <machine>.<tailnet>.ts.net.
SYNTHETIC_TAILNET_HOSTNAMES = %w[
  d.ts.net
  desktop.tailnet.ts.net
  devbox.tailnet.ts.net
  fixture.tailnet.ts.net
  legacy.tailnet.ts.net
].freeze
TAILNET_URL = %r{https?://([^/\s]+)\.ts\.net\b}i
# Documentation placeholders (<this-machine>, ${expr}) are not hostname shapes.
HOSTNAME_SHAPE = /\A[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\z/

def real_tailnet_hostname?(text)
  text.scan(TAILNET_URL).flatten.any? do |host|
    host.match?(HOSTNAME_SHAPE) &&
      !SYNTHETIC_TAILNET_HOSTNAMES.include?("#{host.downcase}.ts.net")
  end
end

def fail!(message, failures)
  warn "FAIL: #{message}"
  failures << message
end

tracked, status = Open3.capture2(
  'git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'
)
abort 'git ls-files failed' unless status.success?
paths = tracked.split("\0").reject(&:empty?)
cached, cached_status = Open3.capture2('git', 'ls-files', '-z', '--cached')
abort 'git ls-files --cached failed' unless cached_status.success?
tracked_paths = {}
cached.split("\0").reject(&:empty?).each { |entry| tracked_paths[entry] = true }
failures = []
golden_policy = FlutterGoldenPolicy.validate(root: ROOT)
FlutterGoldenPolicy.print_report(golden_policy, root: ROOT)
golden_policy.failures.each { |failure| fail!(failure, failures) }
registered_goldens = golden_policy.accepted_paths.to_h { |path| [path, true] }
workflow_mode = File.read(WORKFLOW_MODE_PATH, encoding: 'UTF-8').strip
unless workflow_mode == 'public-hosted'
  fail!("unsupported workflow mode: #{workflow_mode}", failures)
end

allowlist = {}
File.readlines(ALLOWLIST_PATH, chomp: true).each do |line|
  next if line.empty? || line.start_with?('#')
  digest, path = line.split(/\s+/, 2)
  fail!("invalid binary allowlist row: #{line}", failures) unless digest&.match?(/\A[0-9a-f]{64}\z/) && path
  allowlist[path] = digest if path
end

content_exceptions = {}
File.readlines(CONTENT_EXCEPTIONS_PATH, chomp: true).each do |line|
  next if line.empty? || line.start_with?('#')
  digest, path = line.split(/\s+/, 2)
  fail!("invalid content exception row: #{line}", failures) unless digest&.match?(/\A[0-9a-f]{64}\z/) && path
  content_exceptions[path] = digest if path
end

seen_binaries = {}
paths.each do |path|
  parts = path.split('/')
  if parts.first == INTERNAL_DOCS_ROOT
    if tracked_paths[path]
      fail!("tracked internal-docs path in public workflow mode: #{path}", failures)
    end
    next
  end
  basename = parts.last
  extension = File.extname(basename).downcase

  fail!("denied path component: #{path}", failures) if (parts & DENIED_COMPONENTS).any?
  fail!("denied filename: #{path}", failures) if DENIED_BASENAMES.include?(basename)
  fail!("denied personal-name path segment: #{path}", failures) if parts.any? { |part|
    DENIED_PERSONAL_COMPONENT_HASHES.include?(Digest::SHA256.hexdigest(part.downcase))
  }
  fail!("denied extension: #{path}", failures) if DENIED_EXTENSIONS.include?(extension)
  fail!("Windows-incompatible filename: #{path}", failures) if parts.any? { |part|
    part.include?(':') || part.end_with?(' ', '.') || part.match?(WINDOWS_RESERVED)
  }
  fail!("Zone.Identifier remnant: #{path}", failures) if path.include?('Zone.Identifier')
  next unless File.file?(path)
  next if registered_goldens[path]

  bytes = File.binread(path)
  fail!("oversized tracked text file (#{bytes.bytesize} bytes): #{path}", failures) if
    bytes.bytesize > MAX_TEXT_BYTES && !bytes.include?("\0")

  if bytes.include?("\0")
    digest = Digest::SHA256.hexdigest(bytes)
    seen_binaries[path] = digest
    fail!("unreviewed or changed binary: #{path} (#{digest})", failures) unless allowlist[path] == digest
    next
  end

  next if path == __FILE__.sub(%r{\A#{Regexp.escape(ROOT.to_s)}/?}, '')

  text = bytes.force_encoding(Encoding::UTF_8)
  fail!("invalid UTF-8 text: #{path}", failures) unless text.valid_encoding?
  next unless text.valid_encoding?
  ALWAYS_DENIED_TEXT.each do |label, pattern|
    fail!("#{label}: #{path}", failures) if text.match?(pattern)
  end
  next if content_exceptions[path] == Digest::SHA256.hexdigest(bytes)

  forbidden = {
    'personal Unix path' => %r{/(?:home|Users)/[A-Za-z0-9._-]+/},
    'personal Windows path' => %r{[A-Za-z]:[\\/]Users[\\/][^\\/\s]+}i,
    'sibling-repository assumption' => /\.\.\/code_anywhere\b|BROKER_ROOT/,
    'private network URL' => %r{https?://(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)}i,
    'personal runner label' => /Ubuntu3090|mac-dev|howard-win|pi5/,
    'private key block' => /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    'GitHub token shape' => /gh[opsu]_[A-Za-z0-9]{30,}/,
    'OpenAI key shape' => /sk-[A-Za-z0-9]{32,}/,
    'AWS access key shape' => /AKIA[0-9A-Z]{16}/
  }
  forbidden.each do |label, pattern|
    fail!("#{label}: #{path}", failures) if text.match?(pattern)
  end
  fail!("private tailnet hostname: #{path}", failures) if real_tailnet_hostname?(text)

  if path.start_with?('.github/workflows/') && text.match?(/self-hosted/)
    fail!("self-hosted runner in public workflow mode: #{path}", failures)
  end
end

(allowlist.keys - seen_binaries.keys - registered_goldens.keys).each do |path|
  fail!("stale binary allowlist entry: #{path}", failures)
end


content_exceptions.each do |path, digest|
  next unless File.file?(path)
  actual = Digest::SHA256.file(path).hexdigest
  fail!("changed content exception: #{path} (#{actual})", failures) unless actual == digest
end

abort "Public-tree policy failed with #{failures.length} finding(s)." unless failures.empty?
puts "PASS: #{paths.length} tracked paths satisfy the public-tree policy; #{seen_binaries.length} binaries match reviewed hashes."
