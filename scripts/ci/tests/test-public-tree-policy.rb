#!/usr/bin/env ruby
# frozen_string_literal: true

# Policy regressions for scripts/ci/check-public-tree.rb.
#
# Every case builds a throwaway git repository, copies the gate into it, and
# asserts the gate's verdict there. Nothing reads the real repository, so the
# suite stays green while sibling lanes are still neutralizing sources.
#
# Set PUBLIC_TREE_GATE to a mutated copy of the gate to prove a case
# discriminates: deleting the rule a case covers must turn that case red.
#
# This file is itself scanned by the gate, so every forbidden literal below is
# assembled at run time and never appears contiguously in the source.

require 'fileutils'
require 'open3'
require 'tmpdir'

GATE = File.expand_path(
  ENV['PUBLIC_TREE_GATE'] || File.join(__dir__, '..', 'check-public-tree.rb')
)
GIT_ENV = { 'GIT_CONFIG_GLOBAL' => '/dev/null', 'GIT_CONFIG_SYSTEM' => '/dev/null' }.freeze
FAILURES = []

def record(name, passed, detail = nil)
  if passed
    puts "ok   #{name}"
  else
    puts "FAIL #{name}"
    puts detail.to_s.lines.map { |line| "       #{line}" }.join unless detail.nil?
    FAILURES << name
  end
end

def write(dir, relative, content)
  full = File.join(dir, relative)
  FileUtils.mkdir_p(File.dirname(full))
  File.write(full, content)
end

def git(dir, *args)
  output, status = Open3.capture2e(GIT_ENV, 'git', *args, chdir: dir)
  raise "git #{args.join(' ')} failed: #{output}" unless status.success?
end

def run_gate(dir)
  Open3.capture2e(GIT_ENV, 'ruby', 'scripts/ci/check-public-tree.rb', chdir: dir)
end

def with_repo(mode)
  Dir.mktmpdir('public-tree-policy') do |dir|
    FileUtils.mkdir_p(File.join(dir, 'scripts/ci'))
    FileUtils.cp(GATE, File.join(dir, 'scripts/ci/check-public-tree.rb'))
    write(dir, '.github/workflow-mode', "#{mode}\n")
    write(dir, 'scripts/ci/public-binary-allowlist.sha256', "# no reviewed binaries\n")
    write(dir, 'scripts/ci/public-content-exceptions.sha256', "# no reviewed content\n")
    git(dir, 'init', '--quiet')
    git(dir, 'config', 'user.email', 'ci@example.test')
    git(dir, 'config', 'user.name', 'Continuous Integration')
    yield dir
  end
end

# Forbidden literals, assembled so this source stays clean.
def unix_home(name)
  "/home/#{name}/rollouts"
end

def unix_users(name)
  "/Users/#{name}/Library"
end

def windows_users(name)
  "C:\\Users\\#{name}\\projects"
end

def tailnet_url(host)
  'https://' + host + '.ts.net'
end

def private_url(host)
  'http://' + host + '/api/health'
end

def runner_label(prefix, suffix)
  prefix + suffix
end

def internal_docs_ref(section)
  'docs/' + section + '/notes.md'
end

# (a) The retired private workflow mode is rejected.
with_repo('private-self-hosted') do |dir|
  output, status = run_gate(dir)
  record(
    'retired private workflow mode fails closed',
    !status.success? && output.include?('unsupported workflow mode: private-self-hosted'),
    output
  )
end

# (b) Public mode rejects tracked docs-internal content.
with_repo('public-hosted') do |dir|
  write(dir, '.gitignore', "docs-internal/\n")
  write(dir, 'docs-internal/plan.md', "internal only\n")
  git(dir, 'add', '-f', 'docs-internal/plan.md')
  output, status = run_gate(dir)
  record(
    'public mode rejects a tracked docs-internal file',
    !status.success? &&
      output.include?('tracked internal-docs path in public workflow mode: docs-internal/plan.md'),
    output
  )
end

# (c) Public mode allows the ignored nested checkout, in both shapes: listed as
# an ignored path, and listed as an untracked nested repository directory.
with_repo('public-hosted') do |dir|
  write(dir, '.gitignore', "docs-internal/\n")
  write(dir, 'docs-internal/plan.md', "notes under #{unix_home('margaret')}\n")
  git(dir, 'init', '--quiet', 'docs-internal')
  output, status = run_gate(dir)
  record(
    'public mode allows a gitignored nested internal-docs checkout',
    status.success?, output
  )
end

with_repo('public-hosted') do |dir|
  write(dir, 'docs-internal/plan.md', "notes under #{unix_home('margaret')}\n")
  git(dir, 'init', '--quiet', 'docs-internal')
  output, status = run_gate(dir)
  record(
    'public mode allows an untracked nested internal-docs checkout',
    status.success?, output
  )
end

# (d) Every restored personal/private pattern still catches a real example.
POSITIVE_CASES = [
  ['personal Unix path', 'src/unix-home.txt', "opens #{unix_home('margaret')}\n"],
  ['personal Unix path', 'src/unix-users.txt', "opens #{unix_users('margaret')}\n"],
  ['personal Windows path', 'src/windows.txt', "opens #{windows_users('margaret')}\n"],
  ['private network URL', 'src/rfc1918-a.txt', "#{private_url('10.1.2.3')}\n"],
  ['private network URL', 'src/rfc1918-b.txt', "#{private_url('192.168.1.10')}\n"],
  ['private network URL', 'src/rfc1918-c.txt', "#{private_url('172.20.0.5')}\n"],
  ['private network URL', 'src/cgnat.txt', "#{private_url('100.101.102.103')}\n"],
  ['personal runner label', 'src/runner-a.txt', "runs-on: #{runner_label('Ubuntu', '3090')}\n"],
  ['personal runner label', 'src/runner-b.txt', "runs-on: #{runner_label('mac', '-dev')}\n"],
  ['personal runner label', 'src/runner-c.txt', "runs-on: #{runner_label('howard', '-win')}\n"],
  ['personal runner label', 'src/runner-d.txt', "provider #{runner_label('pi', '5')}-litellm\n"],
  ['private tailnet hostname', 'src/tailnet-a.txt', "#{tailnet_url('laptop.tail1a2b3c')}\n"],
  ['private tailnet hostname', 'src/tailnet-b.txt', "#{tailnet_url('wsl.tail42931')}/cosy\n"],
  ['excluded internal documentation reference', 'src/doc-a.txt',
   "see #{internal_docs_ref('04-tech')}\n"],
  ['excluded internal documentation reference', 'src/doc-b.txt',
   "see #{internal_docs_ref('06-roadmap')}\n"],
  ['excluded internal documentation reference', 'src/doc-c.txt',
   "see #{internal_docs_ref('07-guides')}\n"],
  ['excluded internal documentation reference', 'src/doc-d.txt',
   "see #{internal_docs_ref('superpowers')}\n"],
  ['excluded internal documentation reference', 'src/doc-e.txt',
   "see #{internal_docs_ref('20260805-prerelease')}\n"]
].freeze

with_repo('public-hosted') do |dir|
  POSITIVE_CASES.each { |(_, path, content)| write(dir, path, content) }
  output, status = run_gate(dir)
  missing = POSITIVE_CASES.reject { |(label, path, _)| output.include?("#{label}: #{path}") }
  reported = output.lines.count { |line| line.start_with?('FAIL:') }
  record(
    'every restored pattern flags a real example',
    !status.success? && missing.empty?,
    missing.empty? ? output : "missing: #{missing.map { |c| c[1] }.join(', ')}\n#{output}"
  )
  record(
    'restored patterns flag nothing beyond their own example',
    reported == POSITIVE_CASES.length,
    "expected #{POSITIVE_CASES.length} findings, saw #{reported}\n#{output}"
  )
end

# Tailnet narrowing: the allowlist is literal, so nothing that could be a real
# MagicDNS name passes, and documentation placeholders are not hostnames.
ALLOWED_TAILNET_SAMPLES = %w[
  d desktop.tailnet devbox.tailnet fixture.tailnet legacy.tailnet DevBox.Tailnet
].freeze
PLACEHOLDER_TAILNET_SAMPLES = [
  '<this-machine>.<your-tailnet>',
  '${' + "'h'.repeat(75)" + '}'
].freeze
REJECTED_TAILNET_SAMPLES = %w[
  laptop.tail1a2b3c
  wsl.tail42931
  Laptop.Tail1A2B3C
  evil.tailnet
  notdevbox.tailnet
  devbox.tailnet.example
  devbox
].freeze

with_repo('public-hosted') do |dir|
  ALLOWED_TAILNET_SAMPLES.each_with_index do |host, index|
    write(dir, "src/allowed-#{index}.txt", "#{tailnet_url(host)}/cosy\n")
  end
  PLACEHOLDER_TAILNET_SAMPLES.each_with_index do |host, index|
    write(dir, "src/placeholder-#{index}.txt", "#{tailnet_url(host)}\n")
  end
  write(dir, 'src/bare-mention.txt', "the fixture host is fixture.tailnet.ts.net\n")
  output, status = run_gate(dir)
  record('allowlisted synthetic tailnet fixtures pass', status.success?, output)
end

REJECTED_TAILNET_SAMPLES.each_with_index do |host, index|
  with_repo('public-hosted') do |dir|
    write(dir, 'src/candidate.txt', "#{tailnet_url(host)}/cosy\n")
    output, status = run_gate(dir)
    record(
      "tailnet mutation #{index}: a plausible hostname outside the allowlist fails",
      !status.success? && output.include?('private tailnet hostname: src/candidate.txt'),
      output
    )
  end
end

with_repo('public-hosted') do |dir|
  write(
    dir, '.github/workflows/ci.yml',
    "jobs:\n  build:\n    runs-on: [self-hosted, Linux, X64]\n"
  )
  output, status = run_gate(dir)
  record(
    'public mode still rejects self-hosted runners in workflows',
    !status.success? &&
      output.include?('self-hosted runner in public workflow mode: .github/workflows/ci.yml'),
    output
  )
end

# (e) Bun's interrupted-compile scratch never reaches the gate.
#
# `bun build --compile` writes a mode-000 `.bun-build` file in the repository
# root and unlinks it on success, so one only survives a killed build. The gate
# reads every path its discovery command returns, so a single survivor aborts it
# on EACCES; the repository's ignore rule is the only thing keeping the file out
# of that command. The rule is copied from the real `.gitignore` instead of being
# restated here, so narrowing it back to a leading-dot pattern turns this red.
#
# The discovery assertion is the binding one because it holds for any uid. The
# gate-survives assertion is uid-dependent — root can read a mode-000 file — so
# it is evidence rather than the contract.
REPOSITORY_GITIGNORE = File.expand_path(File.join(__dir__, '..', '..', '..', '.gitignore'))
BUN_SCRATCH_NAMES = ['.0a1b2c3d4e5f-0.bun-build', 'plain.bun-build'].freeze

with_repo('public-hosted') do |dir|
  FileUtils.cp(REPOSITORY_GITIGNORE, File.join(dir, '.gitignore'))
  BUN_SCRATCH_NAMES.each do |name|
    scratch = File.join(dir, name)
    File.write(scratch, "interrupted compile\n")
    File.chmod(0o000, scratch)
  end
  discovered, discovery_status = Open3.capture2(
    GIT_ENV, 'git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', chdir: dir
  )
  visible = discovered.split("\0").reject(&:empty?) & BUN_SCRATCH_NAMES
  output, status = run_gate(dir)
  BUN_SCRATCH_NAMES.each { |name| File.chmod(0o600, File.join(dir, name)) }
  record(
    'the shipped ignore rule hides both bun-build scratch shapes from discovery',
    discovery_status.success? && visible.empty?,
    "reached the gate: #{visible.join(', ')}"
  )
  record(
    'an unreadable bun-build scratch does not abort the gate',
    status.success?, output
  )
end

if FAILURES.empty?
  puts 'PASS: public-tree policy regressions hold.'
else
  warn "FAIL: #{FAILURES.length} public-tree policy regression(s) failed."
  exit 1
end
