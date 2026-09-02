#!/usr/bin/env ruby
# frozen_string_literal: true

require 'json'
require 'open3'
require 'pathname'

module FlutterGoldenPolicy
  REGISTRY_PATH = 'scripts/ci/flutter-golden-registry.json'
  APPROVED_ROOTS = %w[
    apps/client/test/src/features/attention/view/goldens
    apps/client/test/src/features/sessions/renderers/goldens
    apps/client/test/src/features/sessions/detail/goldens
    apps/client/test/src/features/sessions/artifacts/goldens
    apps/client/test/src/features/settings/view/goldens
    apps/client/test/src/features/usage/view/goldens
  ].freeze
  MAX_FILE_BYTES = 4 * 1024 * 1024
  MAX_WIDTH = 4096
  MAX_HEIGHT = 4096
  MAX_PIXELS = 8 * 1024 * 1024
  PNG_SIGNATURE = "\x89PNG\r\n\x1a\n".b.freeze
  # Flutter's tracked golden encoder currently emits this exact chunk order.
  # Multiple consecutive IDAT chunks are legitimate; no other ancillary
  # chunks or metadata are accepted without a policy review.
  REQUIRED_CHUNK_SEQUENCE = /\AIHDR,sBIT,sRGB,IDAT(?:,IDAT)*,IEND\z/
  ENTRY_KEYS = %w[path owner family].freeze

  Entry = Struct.new(:path, :owner, :family, keyword_init: true)
  Result = Struct.new(:entries, :accepted_paths, :failures, keyword_init: true)

  # Ownership is policy code, not registry-controlled evidence. Every family
  # expands to an exact path manifest and names one exact test owner. Source
  # fragments bind generated manifests to the Dart template and dimensions
  # that exercise them. Direct-file families list every filename in the test.
  TRANSCRIPT_BOX_NAMES = %w[error permission question artifact].product(
    %w[light dark], %w[compact roomy], %w[en zh]
  ).map { |parts| "transcript_box_#{parts.join('_')}.png" }.sort.freeze
  STATUS_PANEL_NAMES = %w[compact roomy].product(%w[light dark], %w[en zh]).map do |parts|
    "status_panel_#{parts.join('_')}.png"
  end.sort.freeze
  READ_ALOUD_NAMES = %w[light dark].product(%w[en zh]).map do |parts|
    "read_aloud_rate_#{parts.join('_')}.png"
  end.sort.freeze
  # `html_source_only` is deliberate, not a typo for a rendered HTML face:
  # `canRenderHtmlInPane` is false on Linux, where goldens are produced, so the
  # capturable state is the source face plus the notice explaining the limit.
  FILE_PANE_STATES = %w[
    source markdown_rendered html_source_only diff_rendered
    gone binary truncated no_files
  ].freeze
  FILE_PANE_NAMES = (
    FILE_PANE_STATES.product(%w[dark light], %w[en zh]).map do |parts|
      "file_pane_#{parts.join('_')}.png"
    end + %w[file_pane_strip_overflow_light_en.png]
  ).sort.freeze
  FAMILY_RULES = {
    'notifications' => {
      owner: 'apps/client/test/src/features/attention/view/attention_page_test.dart',
      root: 'apps/client/test/src/features/attention/view/goldens',
      names: %w[
        notifications_dark_compact_zh.png
        notifications_dark_roomy_en.png
        notifications_light_compact_en.png
        notifications_light_roomy_zh.png
      ],
      fragments: [
        "matchesGoldenFile('goldens/${evidence.name}.png')",
        "name: 'notifications_dark_compact_zh'",
        "name: 'notifications_dark_roomy_en'",
        "name: 'notifications_light_compact_en'",
        "name: 'notifications_light_roomy_zh'"
      ]
    },
    'code-header' => {
      owner: 'apps/client/test/src/features/sessions/renderers/transcript_markdown_body_test.dart',
      root: 'apps/client/test/src/features/sessions/renderers/goldens',
      names: %w[
        code_header_dark_en.png code_header_dark_zh.png
        code_header_light_en.png code_header_light_zh.png
      ],
      fragments: [
        'matchesGoldenFile(variant.file)',
        "file: 'goldens/code_header_dark_en.png'",
        "file: 'goldens/code_header_dark_zh.png'",
        "file: 'goldens/code_header_light_en.png'",
        "file: 'goldens/code_header_light_zh.png'"
      ]
    },
    'transcript-box' => {
      owner: 'apps/client/test/src/features/sessions/renderers/transcript_box_golden_test.dart',
      root: 'apps/client/test/src/features/sessions/renderers/goldens',
      names: TRANSCRIPT_BOX_NAMES,
      fragments: [
        'enum _GoldenBoxKind { error, permission, question, artifact }',
        'for (final kind in _GoldenBoxKind.values)',
        'for (final brightness in Brightness.values)',
        'for (final width in const [360.0, 720.0])',
        "for (final locale in const [Locale('en'), Locale('zh')])",
        "final sizeName = width == 360 ? 'compact' : 'roomy';",
        "'${kind.name}_${brightness.name}_${sizeName}_'",
        "'${locale.languageCode}';",
        "matchesGoldenFile('goldens/transcript_box_$name.png')"
      ]
    },
    'attachment-composer' => {
      owner: 'apps/client/test/src/features/sessions/detail/session_detail_prompt_composer_test.dart',
      root: 'apps/client/test/src/features/sessions/detail/goldens',
      names: %w[
        attachment_composer_dark_delivery_failure.png
        attachment_composer_light_ready.png
      ],
      fragments: [
        'matchesGoldenFile(',
        "'goldens/attachment_composer_dark_delivery_failure.png'",
        "'goldens/attachment_composer_light_ready.png'"
      ]
    },
    'observe-composer' => {
      owner: 'apps/client/test/src/features/sessions/detail/session_detail_control_test.dart',
      root: 'apps/client/test/src/features/sessions/detail/goldens',
      names: %w[
        observe_composer_compact_dark_zh.png
        observe_composer_compact_light_en.png
      ],
      fragments: [
        'matchesGoldenFile(variant.file)',
        "file: 'goldens/observe_composer_compact_dark_zh.png'",
        "file: 'goldens/observe_composer_compact_light_en.png'"
      ]
    },
    'status-panel' => {
      owner: 'apps/client/test/src/features/sessions/detail/session_detail_status_clarity_test.dart',
      root: 'apps/client/test/src/features/sessions/detail/goldens',
      names: STATUS_PANEL_NAMES,
      fragments: [
        "('compact', Size(420, 900))",
        "('roomy', Size(1280, 900))",
        'for (final (density, size) in densities)',
        "for (final locale in const [Locale('en'), Locale('zh')])",
        'for (final brightness in Brightness.values)',
        "'goldens/status_panel_${density}_${brightness.name}_'",
        "'${locale.languageCode}.png'"
      ]
    },
    'quota-status' => {
      owner: 'apps/client/test/src/features/settings/view/quota_status_panel_test.dart',
      root: 'apps/client/test/src/features/settings/view/goldens',
      names: %w[
        quota_fresh_light_compact_en.png quota_fresh_light_narrow_en.png
        quota_multi_dark_roomy_en.png quota_stale_estimated_dark_compact_zh.png
        quota_unavailable_light_compact_en.png
        quota_warning_critical_light_roomy_zh.png
      ],
      fragments: [
        "matchesGoldenFile('goldens/$name.png')",
        "name: 'quota_fresh_light_compact_en'",
        "name: 'quota_fresh_light_narrow_en'",
        "name: 'quota_multi_dark_roomy_en'",
        "name: 'quota_stale_estimated_dark_compact_zh'",
        "name: 'quota_unavailable_light_compact_en'",
        "name: 'quota_warning_critical_light_roomy_zh'"
      ]
    },
    'read-aloud-rate' => {
      owner: 'apps/client/test/src/features/settings/view/general_settings_page_test.dart',
      root: 'apps/client/test/src/features/settings/view/goldens',
      names: READ_ALOUD_NAMES,
      fragments: [
        "for (final locale in const [Locale('en'), Locale('zh')])",
        'for (final brightness in Brightness.values)',
        "'goldens/read_aloud_rate_${brightness.name}_'",
        "'${locale.languageCode}.png'"
      ]
    },
    'file-pane' => {
      owner: 'apps/client/test/src/features/sessions/artifacts/file_pane_golden_test.dart',
      root: 'apps/client/test/src/features/sessions/artifacts/goldens',
      names: FILE_PANE_NAMES,
      fragments: [
        'const filePaneGoldenStates = <String>[',
        'for (final state in filePaneGoldenStates)',
        "for (final locale in const [Locale('en'), Locale('zh')])",
        'for (final brightness in Brightness.values)',
        '..physicalSize = const Size(720, 620)',
        "'goldens/file_pane_${state}_${brightness.name}_'",
        "'${locale.languageCode}.png'",
        "matchesGoldenFile('goldens/file_pane_strip_overflow_light_en.png')"
      ]
    },
    # The usage surfaces. One test file owns three families because the three
    # subjects are separate widgets sampled on separate axes; splitting the
    # owner would only duplicate the harness.
    'usage-card' => {
      owner: 'apps/client/test/src/features/usage/view/usage_golden_test.dart',
      root: 'apps/client/test/src/features/usage/view/goldens',
      names: %w[
        usage_card_dark_roomy_zh.png
        usage_card_light_compact_en.png
        usage_card_unavailable_dark_compact_en.png
      ],
      fragments: [
        "matchesGoldenFile('goldens/$name.png')",
        "name: 'usage_card_dark_roomy_zh'",
        "name: 'usage_card_light_compact_en'",
        "name: 'usage_card_unavailable_dark_compact_en'"
      ]
    },
    'usage-report' => {
      owner: 'apps/client/test/src/features/usage/view/usage_golden_test.dart',
      root: 'apps/client/test/src/features/usage/view/goldens',
      names: %w[
        usage_report_dark_compact_zh.png
        usage_report_empty_dark_zh.png
        usage_report_light_medium_zh.png
        usage_report_light_roomy_en.png
        usage_report_no_insights_dark_en.png
        usage_report_partial_light_en.png
        usage_report_unavailable_light_en.png
      ],
      fragments: [
        "matchesGoldenFile('goldens/$name.png')",
        "name: 'usage_report_dark_compact_zh'",
        "name: 'usage_report_empty_dark_zh'",
        "name: 'usage_report_light_medium_zh'",
        "name: 'usage_report_light_roomy_en'",
        "name: 'usage_report_no_insights_dark_en'",
        "name: 'usage_report_partial_light_en'",
        "name: 'usage_report_unavailable_light_en'"
      ]
    },
    'usage-export-card' => {
      owner: 'apps/client/test/src/features/usage/view/usage_golden_test.dart',
      root: 'apps/client/test/src/features/usage/view/goldens',
      names: %w[
        usage_export_overview_dark_zh.png
        usage_export_overview_light_en.png
        usage_export_projects_dark_en.png
        usage_export_projects_light_zh.png
      ],
      fragments: [
        "matchesGoldenFile('goldens/$name.png')",
        "name: 'usage_export_overview_dark_zh'",
        "name: 'usage_export_overview_light_en'",
        "name: 'usage_export_projects_dark_en'",
        "name: 'usage_export_projects_light_zh'"
      ]
    },
    # Exact single-path fixture used by the mutation suite. It grants no
    # directory or naming-pattern exemption.
    'policy-fixture' => {
      owner: 'apps/client/test/src/features/attention/view/fixture_test.dart',
      root: 'apps/client/test/src/features/attention/view/goldens',
      names: %w[fixture.png],
      fragments: ["matchesGoldenFile('goldens/fixture.png')"]
    }
  }.transform_values do |rule|
    rule.merge(
      paths: rule.fetch(:names).map { |name| "#{rule.fetch(:root)}/#{name}" }.sort.freeze,
      fragments: rule.fetch(:fragments).freeze
    ).freeze
  end.freeze

  module_function

  def canonical_relative_path?(path)
    path.is_a?(String) && !path.empty? && path.ascii_only? &&
      path.match?(/\A[A-Za-z0-9._\/-]+\z/) && !path.start_with?('/') &&
      !path.include?('\\') && path.split('/').none? { |part| part.empty? || %w[. ..].include?(part) }
  end

  def approved_root_for(path)
    APPROVED_ROOTS.find { |root| path.start_with?("#{root}/") }
  end

  def regular_file_inside?(root, relative, approved_root: nil)
    full = root.join(relative)
    return false unless File.exist?(full) && File.lstat(full).file?

    real = full.realpath.to_s
    boundary = root.realpath.to_s
    return false unless real.start_with?("#{boundary}/")
    return true unless approved_root

    approved = root.join(approved_root).realpath.to_s
    real.start_with?("#{approved}/")
  rescue Errno::ENOENT, Errno::EACCES
    false
  end

  def parse_png(path, label: path)
    failures = []
    size = File.size(path)
    if size > MAX_FILE_BYTES
      return ["oversized golden PNG (#{size} bytes; limit #{MAX_FILE_BYTES}): #{label}"]
    end
    bytes = File.binread(path)
    unless bytes.start_with?(PNG_SIGNATURE)
      return ["invalid PNG signature: #{label}"]
    end

    cursor = PNG_SIGNATURE.bytesize
    chunks = []
    chunk_data = {}
    saw_iend = false
    while cursor < bytes.bytesize
      if bytes.bytesize - cursor < 12
        failures << "truncated PNG chunk framing: #{label}"
        break
      end
      length = bytes.byteslice(cursor, 4).unpack1('N')
      type = bytes.byteslice(cursor + 4, 4)
      chunk_end = cursor + 12 + length
      unless type.match?(/\A[A-Za-z]{4}\z/) && chunk_end <= bytes.bytesize
        failures << "invalid or truncated PNG chunk framing: #{label}"
        break
      end
      data = bytes.byteslice(cursor + 8, length)
      chunks << type
      chunk_data[type] ||= []
      chunk_data[type] << data
      cursor = chunk_end
      next unless type == 'IEND'

      saw_iend = true
      failures << "IEND must be empty: #{label}" unless length.zero?
      failures << "trailing bytes after IEND: #{label}" unless cursor == bytes.bytesize
      break
    end

    failures << "missing IEND chunk: #{label}" unless saw_iend
    unexpected = chunks.uniq - %w[IHDR sBIT sRGB IDAT IEND]
    unexpected.each { |type| failures << "disallowed PNG chunk #{type}: #{label}" }
    unless chunks.join(',').match?(REQUIRED_CHUNK_SEQUENCE)
      failures << "unexpected PNG chunk sequence #{chunks.join(',')}: #{label}"
    end

    ihdr = chunk_data.fetch('IHDR', [])
    if ihdr.length != 1 || ihdr.first&.bytesize != 13
      failures << "PNG must contain one 13-byte IHDR: #{label}"
    else
      width, height, bit_depth, color_type, compression, filter, interlace =
        ihdr.first.unpack('NNCCCCC')
      failures << "invalid PNG dimensions #{width}x#{height}: #{label}" if width.zero? || height.zero?
      failures << "oversized PNG width #{width}: #{label}" if width > MAX_WIDTH
      failures << "oversized PNG height #{height}: #{label}" if height > MAX_HEIGHT
      failures << "oversized PNG pixel count #{width * height}: #{label}" if width * height > MAX_PIXELS
      unless [bit_depth, color_type, compression, filter, interlace] == [8, 6, 0, 0, 0]
        failures << "unexpected Flutter PNG pixel format: #{label}"
      end
    end
    unless chunk_data.fetch('sBIT', []) == [[8, 8, 8, 8].pack('C*')]
      failures << "unexpected Flutter PNG sBIT chunk: #{label}"
    end
    unless chunk_data.fetch('sRGB', []) == [[0].pack('C')]
      failures << "unexpected Flutter PNG sRGB chunk: #{label}"
    end
    if chunk_data.fetch('IDAT', []).empty? || chunk_data.fetch('IDAT', []).any?(&:empty?)
      failures << "PNG must contain non-empty IDAT data: #{label}"
    end
    failures
  rescue Errno::ENOENT, Errno::EACCES => error
    ["cannot read golden PNG #{label}: #{error.message}"]
  end

  def load_registry(root, failures)
    path = root.join(REGISTRY_PATH)
    document = JSON.parse(File.read(path, encoding: 'UTF-8'))
    unless document.is_a?(Hash) && document.keys.sort == %w[goldens version] && document['version'] == 1
      failures << "invalid Flutter golden registry schema: #{REGISTRY_PATH}"
      return []
    end
    unless document['goldens'].is_a?(Array)
      failures << "Flutter golden registry goldens must be an array: #{REGISTRY_PATH}"
      return []
    end
    document['goldens']
  rescue Errno::ENOENT, Errno::EACCES, JSON::ParserError => error
    failures << "cannot load Flutter golden registry #{REGISTRY_PATH}: #{error.message}"
    []
  end

  def validate(root:)
    root = Pathname.new(root).realpath
    failures = []
    rows = load_registry(root, failures)
    tracked, status = Open3.capture2('git', 'ls-files', '-z', '--cached', chdir: root.to_s)
    unless status.success?
      failures << 'git ls-files failed while validating Flutter goldens'
      tracked = ''
    end
    tracked_paths = tracked.split("\0").reject(&:empty?).to_h { |path| [path, true] }

    raw_paths = rows.filter_map do |row|
      row['path'] if row.is_a?(Hash) && row['path'].is_a?(String)
    end
    raw_paths.tally.select { |_, count| count > 1 }.keys.sort.each do |path|
      failures << "duplicate Flutter golden registry path: #{path}"
    end
    failures << "Flutter golden registry paths are not sorted: #{REGISTRY_PATH}" unless raw_paths == raw_paths.sort

    entries = []
    valid_entries = {}
    rows.each_with_index do |row, index|
      entry_failures = []
      unless row.is_a?(Hash) && (row.keys - ENTRY_KEYS).empty? &&
             ENTRY_KEYS.all? { |key| row[key].is_a?(String) && !row[key].empty? }
        failures << "invalid Flutter golden registry entry #{index + 1}"
        next
      end
      entry = Entry.new(
        path: row['path'], owner: row['owner'], family: row['family']
      )
      entries << entry

      unless canonical_relative_path?(entry.path) && File.extname(entry.path) == '.png'
        entry_failures << "non-canonical Flutter golden path: #{entry.path}"
      end
      golden_root = approved_root_for(entry.path)
      entry_failures << "golden path is outside approved Flutter test golden roots: #{entry.path}" unless golden_root
      if golden_root && !regular_file_inside?(root, entry.path, approved_root: golden_root)
        entry_failures << "missing or unsafe registered Flutter golden: #{entry.path}"
      elsif golden_root
        entry_failures.concat(parse_png(root.join(entry.path), label: entry.path))
      end
      entry_failures << "registered Flutter golden is untracked: #{entry.path}" unless tracked_paths[entry.path]

      unless canonical_relative_path?(entry.owner) && entry.owner.end_with?('_test.dart')
        entry_failures << "invalid Flutter golden owner path: #{entry.owner}"
      end
      unless regular_file_inside?(root, entry.owner)
        entry_failures << "missing or unsafe Flutter golden owner: #{entry.owner}"
      end
      entry_failures << "Flutter golden owner is untracked: #{entry.owner}" unless tracked_paths[entry.owner]
      if golden_root && File.dirname(entry.owner) != File.dirname(golden_root)
        entry_failures << "Flutter golden owner is outside its test directory: #{entry.path} -> #{entry.owner}"
      end

      rule = FAMILY_RULES[entry.family]
      if rule.nil?
        entry_failures << "unknown Flutter golden ownership family: #{entry.family}"
      else
        unless entry.owner == rule.fetch(:owner)
          entry_failures << "Flutter golden owner does not match family #{entry.family}: #{entry.path} -> #{entry.owner}"
        end
        unless rule.fetch(:paths).include?(entry.path)
          entry_failures << "Flutter golden path is not produced by family #{entry.family}: #{entry.path}"
        end
      end
      if rule && regular_file_inside?(root, entry.owner)
        owner_source = File.read(root.join(entry.owner), encoding: 'UTF-8')
        missing_fragments = rule.fetch(:fragments).reject { |fragment| owner_source.include?(fragment) }
        unless missing_fragments.empty?
          entry_failures << "Flutter golden family #{entry.family} is not exactly exercised by owner #{entry.owner}"
        end
      end

      failures.concat(entry_failures)
      valid_entries[entry.path] = entry_failures.empty?
    end

    family_expansions = {}
    entries.group_by(&:family).sort.each do |family, family_entries|
      rule = FAMILY_RULES[family]
      next unless rule

      actual = family_entries.map(&:path).sort
      expected = rule.fetch(:paths)
      next if actual == expected

      family_expansions[family] = false
      missing = expected - actual
      unexpected = actual - expected
      failures << "Flutter golden family #{family} registry expansion mismatch" \
        " (missing: #{missing.join(', ')}; unexpected: #{unexpected.join(', ')})"
    end

    accepted_paths = entries.filter_map do |entry|
      rule = FAMILY_RULES[entry.family]
      next unless rule && valid_entries[entry.path] && raw_paths.count(entry.path) == 1
      next if family_expansions[entry.family] == false
      next unless entries.select { |candidate| candidate.family == entry.family }.map(&:path).sort == rule.fetch(:paths)

      entry.path
    end.sort

    registered = raw_paths.to_h { |path| [path, true] }
    APPROVED_ROOTS.each do |golden_root|
      Dir.glob(root.join(golden_root, '**', '*.png').to_s).sort.each do |full|
        relative = Pathname.new(full).relative_path_from(root).to_s
        failures << "unregistered PNG under Flutter golden root: #{relative}" unless registered[relative]
      end
    end

    Result.new(entries: entries.sort_by(&:path), accepted_paths: accepted_paths, failures: failures.uniq)
  end

  def github_changed_paths(root, registered_paths)
    return nil unless ENV['GITHUB_ACTIONS'] == 'true'
    event_path = ENV['GITHUB_EVENT_PATH']
    return nil unless event_path && File.file?(event_path)

    event = JSON.parse(File.read(event_path, encoding: 'UTF-8'))
    base = event.dig('pull_request', 'base', 'sha')
    return nil unless base.is_a?(String) && base.match?(/\A[0-9a-f]{40}\z/)
    _, status = Open3.capture2e('git', 'cat-file', '-e', "#{base}^{commit}", chdir: root.to_s)
    return nil unless status.success?

    changed, diff_status = Open3.capture2(
      'git', 'diff', '--name-only', '-z', "#{base}...HEAD", '--', *registered_paths, chdir: root.to_s
    )
    return nil unless diff_status.success?

    changed.split("\0").reject(&:empty?).sort
  rescue JSON::ParserError, Errno::ENOENT, Errno::EACCES
    nil
  end

  def print_report(result, root:, io: $stdout)
    io.puts "Registered Flutter goldens (#{result.entries.length}):"
    result.entries.each do |entry|
      io.puts "  #{entry.path} | owner=#{entry.owner} | family=#{entry.family}"
    end
    changed = github_changed_paths(Pathname.new(root), result.entries.map(&:path))
    return if changed.nil?

    io.puts "Changed registered Flutter goldens for PR review (#{changed.length}):"
    changed.each { |path| io.puts "  #{path}" }
  end
end

if $PROGRAM_NAME == __FILE__
  root = Pathname.new(__dir__).join('../..').cleanpath
  result = FlutterGoldenPolicy.validate(root: root)
  FlutterGoldenPolicy.print_report(result, root: root)
  result.failures.each { |failure| warn "FAIL: #{failure}" }
  abort "Flutter golden policy failed with #{result.failures.length} finding(s)." unless result.failures.empty?
  puts "PASS: #{result.entries.length} registered Flutter golden PNGs satisfy the dedicated policy."
end
