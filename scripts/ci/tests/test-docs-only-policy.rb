#!/usr/bin/env ruby
# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'open3'
require 'pathname'
require 'tmpdir'
require 'yaml'
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
    # The guard must be PRESENT, not the whole condition: a heavy job may add its own conjunct -- the
    # Windows lane also asks whether any changed path can reach it -- and must still refuse to run on
    # a documentation-only change. Removing the guard is what this detects, not narrowing beside it.
    errors << "#{id} does not fail closed on classification" unless
      block.include?("needs.changes.outputs.docs_only != 'true'")
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
  '.github/workflows/ci.yml' => %w[policy suite linux-android apple windows windows-broker],
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
  # A heavy job that keeps only its OWN condition and drops the docs-only guard is the shape the
  # relaxed check above could have admitted, so it is mutated for explicitly.
  mutation = source.sub(
    "needs.changes.outputs.docs_only != 'true'\n          &&", 'true &&'
  )
  if mutation != source
    record(
      "#{path} mutation: dropping the docs-only guard beside another condition is detected",
      !workflow_contract_errors(mutation, heavy_jobs).empty?
    )
  end
end

# The Windows lane is a REQUIRED check that this classification is allowed to skip, so the
# classification is the thing standing between a Windows regression and main. Both directions
# matter: skipping the lane on a change that reaches it is the expensive mistake, and running it on
# a change that cannot is only the cheap one.
def relevance(paths)
  reason =
    if paths.empty?
      'empty-diff'
    elsif paths.all? { |path| DocsOnlyChangePolicy.documentation_path?(path) }
      'all-paths-are-documentation'
    else
      'non-documentation-path'
    end
  DocsOnlyChangePolicy::Result.new(
    docs_only: reason == 'all-paths-are-documentation', reason: reason, paths: paths
  ).windows_relevant?
end

{
  'broker source is Windows-relevant' => [['packages/typescript/broker/src/main.ts'], true],
  'adapter-api is Windows-relevant' => [['packages/typescript/adapter-api/src/windows-ffi.ts'], true],
  'the scripts tree is Windows-relevant' => [['scripts/ci/lib/windows-lane.ts'], true],
  'a workflow change is Windows-relevant' => [['.github/workflows/ci.yml'], true],
  'a lockfile change is Windows-relevant' => [['bun.lock'], true],
  'an unrecognised top-level path is Windows-relevant' => [['Makefile'], true],
  'documentation is not' => [['docs/a.md', 'README.md'], false],
  'the Flutter client is not' => [['apps/client/lib/main.dart'], false],
  'one relevant path among irrelevant ones still counts' =>
    [['apps/client/lib/main.dart', 'packages/typescript/broker/src/main.ts'], true],
  # A diff the classifier could not read must run the lane, never skip it.
  'an unreadable diff fails closed' => [[], true],
}.each do |name, (paths, expected)|
  actual = relevance(paths)
  record("windows relevance: #{name}", actual == expected, "expected #{expected}, got #{actual}")
end

ci = File.read(ROOT.join('.github/workflows/ci.yml'))
record(
  'the Windows lane always runs on a push, whatever the paths say',
  ci.include?("github.event_name != 'pull_request' || needs.changes.outputs.windows_relevant == 'true'")
)
record(
  'CI required refuses a Windows lane that was skipped for any other reason',
  ci.include?('test "$windows_broker" = skipped') && ci.include?('test "$WINDOWS_RELEVANT" != true')
)

# Browser acquisition is tested at its command boundary without changing host
# packages. Only diagnosed missing libraries/fonts may install dependencies.
Dir.mktmpdir('cosyncing-browser-bootstrap-') do |fixture|
  bin = File.join(fixture, 'bin')
  FileUtils.mkdir_p(bin)
  FileUtils.mkdir_p(File.join(fixture, 'node_modules/playwright-core'))
  File.write(File.join(fixture, 'node_modules/playwright-core/cli.js'), '')
  File.write(File.join(bin, 'bun'), <<~'SH')
    #!/usr/bin/env bash
    set -euo pipefail
    printf '%s\n' "$*" >> "$BROWSER_FIXTURE_LOG"
    if [ "$1" = run ]; then
      count=0
      if [ -f "$BROWSER_FIXTURE_COUNT" ]; then count="$(cat "$BROWSER_FIXTURE_COUNT")"; fi
      count=$((count + 1))
      printf '%s\n' "$count" > "$BROWSER_FIXTURE_COUNT"
      case "$BROWSER_FIXTURE_CASE:$count" in
        missing:1|still-broken:1|both:1) exit 78 ;;
        fonts:1|still-fonts:1|still-fonts:2|both:2) exit 79 ;;
        broken:*|still-broken:2) exit 1 ;;
      esac
    fi
  SH
  FileUtils.chmod(0o755, File.join(bin, 'bun'))
  File.write(File.join(bin, 'sudo'), <<~'SH')
    #!/usr/bin/env bash
    printf '%s\n' "$*" >> "$BROWSER_FIXTURE_LOG"
  SH
  FileUtils.chmod(0o755, File.join(bin, 'sudo'))
  %w[ready missing fonts both broken still-broken still-fonts].each do |scenario|
    log = File.join(fixture, "#{scenario}.log")
    output, status = Open3.capture2e(
      { 'PATH' => "#{bin}:#{ENV.fetch('PATH')}", 'BROWSER_FIXTURE_CASE' => scenario,
        'BROWSER_FIXTURE_LOG' => log, 'BROWSER_FIXTURE_COUNT' => File.join(fixture, "#{scenario}.count") },
      'bash', ROOT.join('scripts/ci/install-browser.sh').to_s, chdir: fixture
    )
    calls = File.readlines(log, chomp: true)
    expected_success = %w[ready missing fonts both].include?(scenario)
    expected_dependency_setup = %w[missing still-broken both].include?(scenario)
    expected_font_setup = %w[fonts both still-fonts].include?(scenario)
    expected_probes = { 'ready' => 1, 'missing' => 2, 'fonts' => 2, 'both' => 3,
                        'broken' => 1, 'still-broken' => 2, 'still-fonts' => 2 }.fetch(scenario)
    record("#{scenario} browser bootstrap has the expected outcome", status.success? == expected_success, output)
    record("#{scenario} browser bootstrap installs dependencies only for missing libraries",
      calls.count { |call| call.include?('install-deps') } == (expected_dependency_setup ? 1 : 0), calls.inspect)
    record("#{scenario} browser bootstrap installs fonts only for missing coverage",
      calls.count { |call| call.start_with?('apt-get install ') && call.include?('fonts-noto-cjk') } == (expected_font_setup ? 1 : 0), calls.inspect)
    record("#{scenario} browser bootstrap does not retry other rendering failures",
      calls.count { |call| call.start_with?('run ') } == expected_probes, calls.inspect)
  end
end

# Tag-time aggregation is too late to discover an incomplete release matrix.
# Exercise the policy CLI with edited workflow fixtures before a tag exists.
Dir.mktmpdir('cosyncing-release-matrix-') do |fixture|
  original = YAML.load_file(ROOT.join('.github/workflows/client-release.yml'))
  %w[valid missing-suite missing-shard overlap wrong-part wrong-name unguarded-signing unguarded-draft
     missing-gate short-staging long-early-apk rehearsal-secrets write-rehearsal bun-literal missing-dispatch
     broker-cache broker-unguarded-signing flutter-drift].each do |scenario|
    workflow = Marshal.load(Marshal.dump(original))
    jobs = workflow.fetch('jobs')
    verify = jobs.fetch('verify')
    rows = verify.fetch('strategy').fetch('matrix').fetch('include')
    broker = YAML.load_file(ROOT.join('.github/workflows/broker-release.yml'))
    case scenario
    when 'missing-suite' then rows.reject! { |row| row['suite'] == 'android' }
    when 'missing-shard' then rows.reject! { |row| row['part'] == 'client-2-3' }
    when 'overlap' then rows << rows.find { |row| row['suite'] == 'packaging' }.dup
    when 'wrong-part' then rows.find { |row| row['part'] == 'client-2-3' }['part'] = 'client'
    when 'wrong-name' then verify['name'] = 'verify ${{ matrix.suite }}'
    when 'unguarded-signing' then jobs.fetch('android').delete('if')
    when 'unguarded-draft' then jobs.fetch('prepare-draft').delete('if')
    when 'missing-gate' then jobs.fetch('stage-verified').fetch('needs').delete('gate')
    when 'short-staging'
      jobs.fetch('stage-verified').fetch('steps').find { |step| step['uses'].to_s.start_with?('actions/upload-artifact@') }.fetch('with')['retention-days'] = 1
    when 'long-early-apk'
      jobs.fetch('android').fetch('steps').find { |step| step['uses'].to_s.start_with?('actions/upload-artifact@') }.fetch('with')['retention-days'] = 30
    when 'rehearsal-secrets' then jobs.fetch('android-rehearsal')['env'] = { 'KEY' => '${{ secrets.RELEASE_KEY }}' }
    when 'write-rehearsal' then jobs.fetch('android-rehearsal')['permissions'] = { 'contents' => 'write' }
    when 'bun-literal'
      jobs.fetch('source').fetch('steps').find { |step| step['uses'].to_s.start_with?('oven-sh/setup-bun@') }.fetch('with')['bun-version'] = '1.4.3'
    when 'missing-dispatch' then (workflow['on'] || workflow[true]).delete('workflow_dispatch')
    when 'broker-cache' then broker.fetch('jobs').fetch('candidate').fetch('steps') << { 'uses' => 'actions/cache@fixture' }
    when 'broker-unguarded-signing' then broker.fetch('jobs').fetch('candidate').delete('if')
    when 'flutter-drift' then workflow.fetch('env')['FLUTTER_VERSION'] = 'different'
    end
    path = File.join(fixture, "#{scenario}.yml")
    broker_path = File.join(fixture, "#{scenario}-broker.yml")
    File.write(path, YAML.dump(workflow))
    File.write(broker_path, YAML.dump(broker))
    output, status = Open3.capture2e('bun', ROOT.join('scripts/ci/audit-release-matrix.ts').to_s, path, broker_path, chdir: ROOT)
    record("#{scenario} release policy is #{scenario == 'valid' ? 'accepted' : 'rejected'} before tagging",
      status.success? == (scenario == 'valid'), output)
  end
end

if FAILURES.empty?
  puts 'PASS: docs-only workflow policy regressions hold.'
else
  warn "FAIL: #{FAILURES.length} docs-only workflow regression(s) failed."
  exit 1
end
