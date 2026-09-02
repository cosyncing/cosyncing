#!/usr/bin/env ruby
# frozen_string_literal: true

require 'open3'
require 'optparse'
require 'pathname'

module DocsOnlyChangePolicy
  Result = Struct.new(:docs_only, :reason, :paths, keyword_init: true) do
    # Whether this diff can change how the broker behaves on Windows.
    #
    # Asked of the SAME diff as docs_only, in the same place, because both questions are "what did
    # this change touch" and a second script would be a second git range to keep in agreement.
    #
    # Deliberately broad and fail-open: anything under the TypeScript packages, the scripts tree, the
    # workspace manifests, or CI itself counts. What it excludes is what demonstrably cannot reach a
    # broker running on Windows -- documentation and the Flutter client. A narrower list would skip
    # the lane on a change that breaks it, and the cost of being wrong in that direction is a Windows
    # regression discovered after merge.
    def windows_relevant?
      return true unless reason == 'all-paths-are-documentation' || paths.any?
      paths.any? { |path| DocsOnlyChangePolicy.windows_relevant_path?(path) }
    end
  end
  ZERO_SHA = '0' * 40

  module_function

  def documentation_path?(path)
    return false unless path.is_a?(String) && path.valid_encoding?
    return false if path.empty? || path.start_with?('/') || path.include?('\\')
    return false if path.split('/').any? { |part| part.empty? || %w[. ..].include?(part) }

    (!path.include?('/') && path.start_with?('README')) || path.start_with?('docs/')
  end

  # Paths that cannot reach a Windows broker. Everything else can.
  IRRELEVANT_PREFIXES = ['docs/', 'apps/client/', 'apps/android/', 'apps/ios/'].freeze

  def windows_relevant_path?(path)
    return true unless path.is_a?(String) && path.valid_encoding?
    return false if documentation_path?(path)

    IRRELEVANT_PREFIXES.none? { |prefix| path.start_with?(prefix) }
  end

  def commit_exists?(root, revision)
    return false unless revision&.match?(/\A[0-9a-f]{40}\z/i) && revision != ZERO_SHA

    _, status = Open3.capture2e(
      'git', 'rev-parse', '--verify', "#{revision}^{commit}", chdir: root.to_s
    )
    status.success?
  end

  def changed_paths(root:, event_name:, base:, head:)
    return Result.new(docs_only: false, reason: "unsupported-event:#{event_name}", paths: []) unless
      %w[pull_request push].include?(event_name)
    return Result.new(docs_only: false, reason: 'missing-base', paths: []) unless
      commit_exists?(root, base)
    return Result.new(docs_only: false, reason: 'missing-head', paths: []) unless
      commit_exists?(root, head)

    range = event_name == 'pull_request' ? "#{base}...#{head}" : "#{base}..#{head}"
    output, status = Open3.capture2e(
      'git', 'diff', '--name-status', '-z', '--find-renames', range, '--', chdir: root.to_s
    )
    return Result.new(docs_only: false, reason: 'diff-failed', paths: []) unless status.success?

    fields = output.b.split("\0").reject(&:empty?)
    paths = []
    until fields.empty?
      change = fields.shift&.force_encoding(Encoding::UTF_8)
      return Result.new(docs_only: false, reason: 'invalid-diff', paths: []) unless
        change&.valid_encoding? && change.match?(/\A(?:[ACDMTUXB]|[RC][0-9]{1,3})\z/)

      path_count = change.start_with?('R', 'C') ? 2 : 1
      path_count.times do
        raw_path = fields.shift
        return Result.new(docs_only: false, reason: 'invalid-diff', paths: []) unless raw_path

        path = raw_path.force_encoding(Encoding::UTF_8)
        return Result.new(docs_only: false, reason: 'invalid-path', paths: []) unless path.valid_encoding?

        paths << path
      end
    end
    paths = paths.uniq.sort
    return Result.new(docs_only: false, reason: 'empty-diff', paths: []) if paths.empty?

    docs_only = paths.all? { |path| documentation_path?(path) }
    Result.new(
      docs_only: docs_only,
      reason: docs_only ? 'all-paths-are-documentation' : 'non-documentation-path',
      paths: paths
    )
  rescue Errno::ENOENT, Errno::EACCES
    Result.new(docs_only: false, reason: 'diff-unavailable', paths: [])
  end

  def write_github_output(path, result)
    return unless path && !path.empty?

    File.open(path, 'a', encoding: 'UTF-8') do |output|
      output.puts "docs_only=#{result.docs_only}"
      output.puts "windows_relevant=#{result.windows_relevant?}"
      output.puts "reason=#{result.reason}"
      output.puts "changed_count=#{result.paths.length}"
    end
  end
end

if $PROGRAM_NAME == __FILE__
  options = {
    event_name: ENV['GITHUB_EVENT_NAME'],
    base: ENV['BASE_SHA'],
    head: ENV['HEAD_SHA'],
    output: ENV['GITHUB_OUTPUT'],
    root: Pathname.new(__dir__).join('../..').cleanpath
  }
  OptionParser.new do |parser|
    parser.on('--event NAME') { |value| options[:event_name] = value }
    parser.on('--base SHA') { |value| options[:base] = value }
    parser.on('--head SHA') { |value| options[:head] = value }
    parser.on('--output PATH') { |value| options[:output] = value }
    parser.on('--root PATH') { |value| options[:root] = Pathname.new(value) }
  end.parse!

  result = DocsOnlyChangePolicy.changed_paths(
    root: Pathname.new(options[:root]).realpath,
    event_name: options[:event_name].to_s,
    base: options[:base].to_s,
    head: options[:head].to_s
  )
  DocsOnlyChangePolicy.write_github_output(options[:output], result)
  puts "docs_only=#{result.docs_only} windows_relevant=#{result.windows_relevant?} "\
       "reason=#{result.reason} changed_count=#{result.paths.length}"
  result.paths.each { |path| puts "  #{path}" }
end
