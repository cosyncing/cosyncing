#!/usr/bin/env ruby
# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'open3'
require 'pathname'
require 'tmpdir'
require_relative '../classify-docs-only'

ROOT = Pathname.new(__dir__).join('../../..').cleanpath
FAILURES = []

def record(name, passed, detail = nil)
  if passed
    puts "ok   #{name}"
  else
    puts "FAIL #{name}"
    puts "     #{detail}" if detail
    FAILURES << name
  end
end

def git(root, *args)
  output, status = Open3.capture2e(
    { 'GIT_CONFIG_GLOBAL' => '/dev/null', 'GIT_CONFIG_SYSTEM' => '/dev/null' },
    'git', *args, chdir: root
  )
  raise "git #{args.join(' ')} failed: #{output}" unless status.success?
  output.strip
end

def write(root, path, content)
  full = File.join(root, path)
  FileUtils.mkdir_p(File.dirname(full))
  File.write(full, content)
end

def write_binary(root, path, content)
  full = File.join(root, path)
  FileUtils.mkdir_p(File.dirname(full))
  File.binwrite(full, content)
end

def commit(root, message, changes)
  changes.each { |path, content| write(root, path, content) }
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', message)
  git(root, 'rev-parse', 'HEAD')
end

def classify(root, event, base, head)
  DocsOnlyChangePolicy.changed_paths(
    root: Pathname.new(root), event_name: event, base: base, head: head
  )
end

def with_public_tree_fixture
  Dir.mktmpdir('cosyncing-docs-public-tree-') do |root|
    git(root, 'init', '--quiet')
    git(root, 'config', 'user.email', 'ci@example.test')
    git(root, 'config', 'user.name', 'Continuous Integration')
    FileUtils.mkdir_p(File.join(root, 'scripts/ci'))
    FileUtils.cp(ROOT.join('scripts/ci/check-public-tree.rb'), File.join(root, 'scripts/ci'))
    FileUtils.cp(ROOT.join('scripts/ci/check-flutter-goldens.rb'), File.join(root, 'scripts/ci'))
    write(root, '.github/workflow-mode', "public-hosted\n")
    write(root, 'scripts/ci/public-binary-allowlist.sha256', "# no reviewed binaries\n")
    write(root, 'scripts/ci/public-content-exceptions.sha256', "# no content exceptions\n")
    write(
      root,
      'scripts/ci/flutter-golden-registry.json',
      JSON.pretty_generate({ 'version' => 1, 'goldens' => [] }) + "\n"
    )
    base = commit(root, 'policy base', { 'README.md' => "fixture\n" })
    yield root, base
  end
end

def run_public_tree(root)
  Open3.capture2e(
    { 'GIT_CONFIG_GLOBAL' => '/dev/null', 'GIT_CONFIG_SYSTEM' => '/dev/null' },
    'ruby', 'scripts/ci/check-public-tree.rb', chdir: root
  )
end

Dir.mktmpdir('cosyncing-docs-policy-') do |root|
  git(root, 'init', '--quiet')
  git(root, 'config', 'user.email', 'ci@example.test')
  git(root, 'config', 'user.name', 'Continuous Integration')
  base = commit(root, 'base', { 'src/app.ts' => "export const value = 1;\n" })

  docs_head = commit(root, 'docs', {
    'README.md' => "project\n",
    'README.zh-CN.md' => "project zh\n",
    'docs/guide.md' => "guide\n"
  })
  result = classify(root, 'pull_request', base, docs_head)
  record(
    'docs-only pull request is classified for lightweight required checks',
    result.docs_only && result.reason == 'all-paths-are-documentation',
    result.inspect
  )
  result = classify(root, 'push', base, docs_head)
  record(
    'docs-only merge push is classified for lightweight required checks',
    result.docs_only && result.paths == %w[README.md README.zh-CN.md docs/guide.md],
    result.inspect
  )

  mixed_head = commit(root, 'mixed', {
    'docs/guide.md' => "guide two\n",
    'src/app.ts' => "export const value = 2;\n"
  })
  result = classify(root, 'pull_request', docs_head, mixed_head)
  record(
    'mixed documentation and source changes run full CI',
    !result.docs_only && result.reason == 'non-documentation-path',
    result.inspect
  )

  workflow_head = commit(root, 'workflow', {
    '.github/workflows/ci.yml' => "name: CI\n"
  })
  result = classify(root, 'push', mixed_head, workflow_head)
  record(
    'workflow changes run full CI',
    !result.docs_only && result.paths == ['.github/workflows/ci.yml'],
    result.inspect
  )

  ci_script_head = commit(root, 'ci-script', {
    'scripts/ci/docs-only-helper.rb' => "raise 'fixture'\n"
  })
  result = classify(root, 'pull_request', workflow_head, ci_script_head)
  record(
    'CI scripts cannot be classified as documentation',
    !result.docs_only && result.paths == ['scripts/ci/docs-only-helper.rb'],
    result.inspect
  )

  result = classify(root, 'pull_request', 'f' * 40, ci_script_head)
  record(
    'missing pull-request base evidence runs full CI',
    !result.docs_only && result.reason == 'missing-base',
    result.inspect
  )
  result = classify(root, 'push', '0' * 40, ci_script_head)
  record(
    'missing merge-push base evidence runs full CI',
    !result.docs_only && result.reason == 'missing-base',
    result.inspect
  )
end


with_public_tree_fixture do |root, base|
  private_key_marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join
  head = commit(root, 'forbidden docs text', {
    'docs/security-note.md' => "#{private_key_marker}\nfixture\n"
  })
  result = classify(root, 'pull_request', base, head)
  output, status = run_public_tree(root)
  record(
    'forbidden text under docs blocks both required checks',
    result.docs_only && !status.success? && output.include?('private key block'),
    "classification=#{result.inspect}\n#{output}"
  )
end

with_public_tree_fixture do |root, base|
  write_binary(
    root,
    'docs/capture.png',
    [137, 80, 78, 71, 13, 10, 26, 10, 0].pack('C*')
  )
  git(root, 'add', 'docs/capture.png')
  head = git(root, 'commit', '--quiet', '-m', 'unreviewed docs binary') && git(root, 'rev-parse', 'HEAD')
  result = classify(root, 'push', base, head)
  output, status = run_public_tree(root)
  record(
    'an unreviewed binary under docs blocks both required checks',
    result.docs_only && !status.success? && output.include?('unreviewed or changed binary'),
    "classification=#{result.inspect}\n#{output}"
  )
end

def job_block(source, id)
  source[/^  #{Regexp.escape(id)}:\n(?:(?!^  [a-zA-Z0-9_-]+:\n).)*/m].to_s
end

def workflow_contract_errors(source, heavy_jobs)
  errors = []
  changes = job_block(source, 'changes')
  errors << 'missing changes job' if changes.empty?
  errors << 'classifier checkout is shallow' unless changes.include?('fetch-depth: 0')
  errors << 'classifier command is missing' unless changes.include?('ruby scripts/ci/classify-docs-only.rb')
  errors << 'pull-request base is missing' unless changes.include?('github.event.pull_request.base.sha')
  errors << 'merge-push base is missing' unless changes.include?('github.event.before')
  errors << 'docs-only output is missing' unless changes.include?('docs_only: ${{ steps.classify.outputs.docs_only }}')
  errors << 'docs-only public-tree enforcement is missing' unless
    changes.include?("if: ${{ steps.classify.outputs.docs_only == 'true' }}") &&
      changes.include?('run: ruby scripts/ci/check-public-tree.rb')
  heavy_jobs.each do |id|
    block = job_block(source, id)
    errors << "missing heavy job #{id}" if block.empty?
    errors << "#{id} does not need classification" unless block.include?('needs: changes')
    errors << "#{id} does not fail closed on classification" unless
      block.include?("if: ${{ needs.changes.outputs.docs_only != 'true' }}")
  end
  required = job_block(source, 'required')
  expected_needs = "needs: [changes, #{heavy_jobs.join(', ')}]"
  errors << 'required job does not bind classification and every heavy job' unless
    required.include?(expected_needs)
  errors << 'required job does not prove intentional docs-only skips' unless
    required.include?('DOCS_ONLY: ${{ needs.changes.outputs.docs_only }}') &&
      required.include?('all(. == "skipped")') && required.include?('all(. == "success")')
  errors
end

workflow_cases = {
  '.github/workflows/ci.yml' => %w[current-host linux-android apple windows windows-broker],
  '.github/workflows/broker-release-gate.yml' => %w[native-package broker-web-pair]
}
workflow_cases.each do |path, heavy_jobs|
  source = File.read(ROOT.join(path), encoding: 'UTF-8')
  errors = workflow_contract_errors(source, heavy_jobs)
  record("#{path} has fail-closed docs-only wiring", errors.empty?, errors.join('; '))

  mutation = source.sub('needs: changes', 'needs: []')
  record(
    "#{path} mutation: heavy job classification dependency removal is detected",
    !workflow_contract_errors(mutation, heavy_jobs).empty?
  )
  mutation = source.sub("if: ${{ needs.changes.outputs.docs_only != 'true' }}", 'if: ${{ true }}')
  record(
    "#{path} mutation: unconditional heavy execution is detected",
    !workflow_contract_errors(mutation, heavy_jobs).empty?
  )
  mutation = source.sub('run: ruby scripts/ci/check-public-tree.rb', 'run: true')
  record(
    "#{path} mutation: docs-only public-tree bypass is detected",
    !workflow_contract_errors(mutation, heavy_jobs).empty?
  )
end

if FAILURES.empty?
  puts 'PASS: docs-only workflow policy regressions hold.'
else
  warn "FAIL: #{FAILURES.length} docs-only workflow regression(s) failed."
  exit 1
end
