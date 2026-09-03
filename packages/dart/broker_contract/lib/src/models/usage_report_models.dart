/// Typed models for `GET /api/tokdash/report`.
///
/// Mirrors the broker's
/// `packages/typescript/broker/src/installation/tokdash-report.ts`. The DTO is
/// a projection of Tokdash's own aggregation, and two of its shapes carry
/// product rules the client must not re-derive:
///
/// * Every facet is nullable. A Tokdash older than 2.5.0 serves no insights
///   scan at all, and the report still renders — minus the sections those
///   facets feed. `null` here means "no data exists", never "zero", and a
///   surface that renders 0 for it is telling the user something untrue.
/// * [UsageReportTotals.tokens] is the period denominator, and it is
///   deliberately larger than the project rows sum to. See
///   [UsageProjectReconciliation].
library;

/// Why the project facet alone is absent from a report.
///
/// Distinct from [UsageInsightsRefusal]: the facets can all be missing because
/// Tokdash could not serve them, or the project facet alone can be withheld
/// from a caller allowed the counts but not the names. Those read the same in
/// the DTO — `projects: null` — and mean different things to the reader.
enum UsageProjectsRefusal {
  /// The caller is not the owner, so project names were not served.
  ownerOnly,

  /// A refusal this client does not know. Newer brokers may add reasons.
  unknown;

  /// Decodes a served refusal code, tolerating values added after this client
  /// shipped.
  static UsageProjectsRefusal? fromJson(Object? value) {
    if (value == null) return null;
    return switch (value) {
      'owner-only' => UsageProjectsRefusal.ownerOnly,
      _ => UsageProjectsRefusal.unknown,
    };
  }
}

/// Why the insights facets are absent from a report.
enum UsageInsightsRefusal {
  /// This Tokdash has no insights API — it predates 2.5.0.
  unsupported,

  /// The scan exists and failed.
  unavailable,

  /// The scan answered with something that is not an insights body.
  malformed,

  /// A refusal this client does not know. Newer brokers may add reasons.
  unknown;

  /// Decodes a served refusal code, tolerating values added after this client
  /// shipped.
  static UsageInsightsRefusal? fromJson(Object? value) {
    if (value == null) return null;
    return switch (value) {
      'unsupported' => UsageInsightsRefusal.unsupported,
      'unavailable' => UsageInsightsRefusal.unavailable,
      'malformed' => UsageInsightsRefusal.malformed,
      _ => UsageInsightsRefusal.unknown,
    };
  }
}

double? _optionalDouble(Object? value) =>
    value is num ? value.toDouble() : null;

int? _optionalInt(Object? value) => value is num ? value.toInt() : null;

double _doubleOrZero(Object? value) => _optionalDouble(value) ?? 0;

int _intOrZero(Object? value) => _optionalInt(value) ?? 0;

String? _optionalString(Object? value) =>
    value is String && value.isNotEmpty ? value : null;

List<Map<String, dynamic>> _objectList(Object? value) {
  if (value is! List) return const [];
  return value.whereType<Map<String, dynamic>>().toList(growable: false);
}

List<String> _stringList(Object? value) {
  if (value is! List) return const [];
  return value.whereType<String>().toList(growable: false);
}

List<int> _intList(Object? value) {
  if (value is! List) return const [];
  return value
      .whereType<num>()
      .map((entry) => entry.toInt())
      .toList(
        growable: false,
      );
}

/// The window a report covers, as Tokdash resolved it.
class UsageReportRange {
  /// Creates a range.
  const UsageReportRange({
    required this.from,
    required this.to,
    required this.recognized,
    this.days,
    this.periodResolved,
  });

  /// Decodes a range.
  factory UsageReportRange.fromJson(Map<String, dynamic> json) =>
      UsageReportRange(
        from: json['from'] as String? ?? '',
        to: json['to'] as String? ?? '',
        recognized: json['recognized'] == true,
        days: _optionalInt(json['days']),
        periodResolved: _optionalString(json['periodResolved']),
      );

  /// Inclusive first day.
  final String from;

  /// Inclusive last day.
  final String to;

  /// Whether Tokdash understood the requested window.
  ///
  /// An unrecognized period silently resolves to all time upstream, so a
  /// surface that renders a figure without checking this can print a year's
  /// totals under "This week". Guard it before rendering anything.
  final bool recognized;

  /// Days in the window, as served.
  final int? days;

  /// Tokdash's resolved period alias. An input to labelling, never a label:
  /// derive window copy from [days], [from] and [to] instead.
  final String? periodResolved;
}

/// Period totals. The denominator every share on every surface reconciles
/// against.
class UsageReportTotals {
  /// Creates totals.
  const UsageReportTotals({
    required this.tokens,
    required this.cost,
    required this.requests,
    this.tokensIn,
    this.tokensOut,
    this.tokensCache,
    this.cacheHitRate,
  });

  /// Decodes totals.
  factory UsageReportTotals.fromJson(Map<String, dynamic> json) =>
      UsageReportTotals(
        tokens: _doubleOrZero(json['tokens']),
        cost: _doubleOrZero(json['cost']),
        requests: _intOrZero(json['requests']),
        tokensIn: _optionalDouble(json['tokensIn']),
        tokensOut: _optionalDouble(json['tokensOut']),
        tokensCache: _optionalDouble(json['tokensCache']),
        cacheHitRate: _optionalDouble(json['cacheHitRate']),
      );

  /// Total tokens in the window.
  ///
  /// Held as a double because the year figure exceeds 2^53 in no realistic case
  /// but comfortably exceeds a 32-bit int, and the web target's ints are
  /// doubles anyway.
  final double tokens;

  /// API list-price equivalent. Never render bare — see the cost qualifier
  /// rule.
  final double cost;

  /// Requests (Tokdash's `messages`).
  final int requests;

  /// Input tokens across coding apps.
  final double? tokensIn;

  /// Output tokens across coding apps.
  final double? tokensOut;

  /// Cache-read tokens across coding apps.
  final double? tokensCache;

  /// Cache hit rate, 0..1.
  final double? cacheHitRate;
}

/// Movement against the equal-length prior window.
class UsageReportComparison {
  /// Creates a comparison.
  const UsageReportComparison({
    this.tokensPrev,
    this.costPrev,
    this.requestsPrev,
    this.tokensPct,
    this.costPct,
    this.requestsPct,
  });

  /// Decodes a comparison.
  factory UsageReportComparison.fromJson(Map<String, dynamic> json) =>
      UsageReportComparison(
        tokensPrev: _optionalDouble(json['tokensPrev']),
        costPrev: _optionalDouble(json['costPrev']),
        requestsPrev: _optionalDouble(json['requestsPrev']),
        tokensPct: _optionalDouble(json['tokensPct']),
        costPct: _optionalDouble(json['costPct']),
        requestsPct: _optionalDouble(json['requestsPct']),
      );

  /// Prior-window tokens.
  final double? tokensPrev;

  /// Prior-window cost.
  final double? costPrev;

  /// Prior-window requests.
  final double? requestsPrev;

  /// Percent change in tokens.
  final double? tokensPct;

  /// Percent change in cost.
  final double? costPct;

  /// Percent change in requests.
  final double? requestsPct;
}

/// Estimated agent activity time.
class UsageReportActiveTime {
  /// Creates an active-time block.
  const UsageReportActiveTime({
    required this.estimated,
    this.activeMs,
    this.activeMsSum,
    this.activeMsPct,
    this.gapCapMs,
    this.method,
    this.sessions,
  });

  /// Decodes an active-time block.
  factory UsageReportActiveTime.fromJson(Map<String, dynamic> json) =>
      UsageReportActiveTime(
        estimated: json['estimated'] != false,
        activeMs: _optionalDouble(json['activeMs']),
        activeMsSum: _optionalDouble(json['activeMsSum']),
        activeMsPct: _optionalDouble(json['activeMsPct']),
        gapCapMs: _optionalDouble(json['gapCapMs']),
        method: _optionalString(json['method']),
        sessions: _optionalInt(json['sessions']),
      );

  /// Whether the figure is an estimate. It always is; the flag is Tokdash's own
  /// declaration.
  final bool estimated;

  /// Merged wall-clock activity across overlapping agents.
  final double? activeMs;

  /// Naive per-agent sum — the parallel agent-hours figure.
  final double? activeMsSum;

  /// Percent change against the prior window.
  final double? activeMsPct;

  /// Idle gap above which time stops accruing, so the estimate can be
  /// explained.
  final double? gapCapMs;

  /// Tokdash's estimation method id.
  final String? method;

  /// Sessions counted across tools.
  final int? sessions;
}

/// One tool's contribution.
///
/// Absent cells stay `null` on purpose: Tokdash's active-time API has no rows
/// for several sources, and rendering 0 sessions for a tool that simply is not
/// measured is a different claim than rendering an em dash.
class UsageReportTool {
  /// Creates a tool row.
  const UsageReportTool({
    required this.tool,
    required this.tokens,
    required this.cost,
    required this.coding,
    this.label,
    this.tokensIn,
    this.tokensOut,
    this.tokensCache,
    this.cacheHitRate,
    this.requests,
    this.sessions,
    this.activeMs,
  });

  /// Decodes a tool row.
  factory UsageReportTool.fromJson(Map<String, dynamic> json) =>
      UsageReportTool(
        tool: json['tool'] as String? ?? '',
        tokens: _doubleOrZero(json['tokens']),
        cost: _doubleOrZero(json['cost']),
        coding: json['coding'] == true,
        label: _optionalString(json['label']),
        tokensIn: _optionalDouble(json['tokensIn']),
        tokensOut: _optionalDouble(json['tokensOut']),
        tokensCache: _optionalDouble(json['tokensCache']),
        cacheHitRate: _optionalDouble(json['cacheHitRate']),
        requests: _optionalInt(json['requests']),
        sessions: _optionalInt(json['sessions']),
        activeMs: _optionalDouble(json['activeMs']),
      );

  /// Tokdash's tool id.
  final String tool;

  /// Tokdash's human label, when the active-time API has one.
  final String? label;

  /// Tokens attributed to this tool.
  final double tokens;

  /// API list-price equivalent for this tool.
  final double cost;

  /// Input tokens, when the coding-apps view has them.
  final double? tokensIn;

  /// Output tokens, when the coding-apps view has them.
  final double? tokensOut;

  /// Cache-read tokens, when the coding-apps view has them.
  final double? tokensCache;

  /// Cache hit rate, 0..1.
  final double? cacheHitRate;

  /// Requests, when the coding-apps view has them.
  final int? requests;

  /// Sessions, when the active-time API has them.
  final int? sessions;

  /// Active milliseconds, when the active-time API has them.
  final double? activeMs;

  /// Whether Tokdash counts this source among the coding apps.
  final bool coding;
}

/// One model's contribution, in the order Tokdash served it.
class UsageReportModel {
  /// Creates a model row.
  const UsageReportModel({
    required this.name,
    required this.tokens,
    required this.cost,
    this.tokensIn,
    this.tokensOut,
    this.tokensCache,
    this.requests,
  });

  /// Decodes a model row.
  factory UsageReportModel.fromJson(Map<String, dynamic> json) =>
      UsageReportModel(
        name: json['name'] as String? ?? '',
        tokens: _doubleOrZero(json['tokens']),
        cost: _doubleOrZero(json['cost']),
        tokensIn: _optionalDouble(json['tokensIn']),
        tokensOut: _optionalDouble(json['tokensOut']),
        tokensCache: _optionalDouble(json['tokensCache']),
        requests: _optionalInt(json['requests']),
      );

  /// Model name. A brand name, exempt from translation.
  final String name;

  /// Tokens for this model.
  final double tokens;

  /// API list-price equivalent for this model.
  final double cost;

  /// Input tokens.
  final double? tokensIn;

  /// Output tokens.
  final double? tokensOut;

  /// Cache-read tokens.
  final double? tokensCache;

  /// Requests.
  final int? requests;
}

/// One hour-of-day bucket.
class UsageReportHourBucket {
  /// Creates an hour bucket.
  const UsageReportHourBucket({
    required this.hour,
    required this.tokens,
    required this.cost,
    required this.requests,
  });

  /// Decodes an hour bucket.
  factory UsageReportHourBucket.fromJson(Map<String, dynamic> json) =>
      UsageReportHourBucket(
        hour: _intOrZero(json['hour']),
        tokens: _doubleOrZero(json['tokens']),
        cost: _doubleOrZero(json['cost']),
        requests: _intOrZero(json['requests']),
      );

  /// Hour 0-23 in the broker host's local zone.
  final int hour;

  /// Tokens burned in this hour across the window.
  final double tokens;

  /// API list-price equivalent.
  final double cost;

  /// Requests.
  final int requests;
}

/// Hour-of-day distribution.
class UsageReportHourly {
  /// Creates an hourly facet.
  const UsageReportHourly({
    required this.buckets,
    required this.nightHours,
    this.peakHour,
    this.nightShare,
  });

  /// Decodes an hourly facet.
  factory UsageReportHourly.fromJson(Map<String, dynamic> json) =>
      UsageReportHourly(
        buckets: _objectList(
          json['buckets'],
        ).map(UsageReportHourBucket.fromJson).toList(growable: false),
        nightHours: _intList(json['nightHours']),
        peakHour: _optionalInt(json['peakHour']),
        nightShare: _optionalDouble(json['nightShare']),
      );

  /// Buckets, as served. Not necessarily 24, and not necessarily ordered.
  final List<UsageReportHourBucket> buckets;

  /// The hours Tokdash counts as night.
  ///
  /// Served, never assumed. It is `{22, 23, 0, 1}` on this host today and the
  /// night-owl figure is computed against it upstream, so a hardcoded window
  /// would label a number it did not produce.
  final List<int> nightHours;

  /// The busiest hour.
  final int? peakHour;

  /// Share of tokens inside [nightHours], 0..1.
  final double? nightShare;
}

/// One day-of-week bucket.
class UsageReportWeekdayBucket {
  /// Creates a weekday bucket.
  const UsageReportWeekdayBucket({
    required this.weekday,
    required this.tokens,
    required this.cost,
    required this.requests,
    this.name,
  });

  /// Decodes a weekday bucket.
  factory UsageReportWeekdayBucket.fromJson(Map<String, dynamic> json) =>
      UsageReportWeekdayBucket(
        weekday: _intOrZero(json['weekday']),
        tokens: _doubleOrZero(json['tokens']),
        cost: _doubleOrZero(json['cost']),
        requests: _intOrZero(json['requests']),
        name: _optionalString(json['name']),
      );

  /// Weekday index, Monday-first as Tokdash serves it.
  final int weekday;

  /// Tokdash's English day name. Never rendered: the client localizes from
  /// [weekday].
  final String? name;

  /// Tokens on this weekday across the window.
  final double tokens;

  /// API list-price equivalent.
  final double cost;

  /// Requests.
  final int requests;
}

/// Day-of-week distribution.
class UsageReportWeekday {
  /// Creates a weekday facet.
  const UsageReportWeekday({required this.buckets, this.peakWeekday});

  /// Decodes a weekday facet.
  factory UsageReportWeekday.fromJson(Map<String, dynamic> json) =>
      UsageReportWeekday(
        buckets: _objectList(
          json['buckets'],
        ).map(UsageReportWeekdayBucket.fromJson).toList(growable: false),
        peakWeekday: _optionalInt(json['peakWeekday']),
      );

  /// Buckets, as served.
  final List<UsageReportWeekdayBucket> buckets;

  /// The busiest weekday index.
  final int? peakWeekday;
}

/// One calendar day.
class UsageReportDay {
  /// Creates a day.
  const UsageReportDay({
    required this.date,
    required this.tokens,
    required this.cost,
    required this.requests,
    this.intensity,
  });

  /// Decodes a day.
  factory UsageReportDay.fromJson(Map<String, dynamic> json) => UsageReportDay(
    date: json['date'] as String? ?? '',
    tokens: _doubleOrZero(json['tokens']),
    cost: _doubleOrZero(json['cost']),
    requests: _intOrZero(json['requests']),
    intensity: _optionalInt(json['intensity']),
  );

  /// ISO `YYYY-MM-DD`.
  final String date;

  /// Tokens on this day.
  final double tokens;

  /// API list-price equivalent.
  final double cost;

  /// Requests.
  final int requests;

  /// Served quartile rank, 1-4 over active days.
  ///
  /// The heatmap shades by this and never recomputes it, so cosyncing and the
  /// Tokdash dashboard cannot disagree about what a cell means. Rank rather
  /// than magnitude is deliberate: with one outlier day, share-of-max renders a
  /// busy year as almost entirely idle.
  final int? intensity;
}

/// One project row.
class UsageReportProjectRow {
  /// Creates a project row.
  const UsageReportProjectRow({
    required this.project,
    required this.tokens,
    required this.cost,
    required this.requests,
  });

  /// Decodes a project row.
  factory UsageReportProjectRow.fromJson(Map<String, dynamic> json) =>
      UsageReportProjectRow(
        project: json['project'] as String? ?? '',
        tokens: _doubleOrZero(json['tokens']),
        cost: _doubleOrZero(json['cost']),
        requests: _intOrZero(json['requests']),
      );

  /// Project basename.
  ///
  /// Amber tier: it may render on the project-detail export card and must never
  /// render on the green card, and must never reach a log line.
  final String project;

  /// Tokens attributed to this project.
  final double tokens;

  /// API list-price equivalent.
  final double cost;

  /// Requests.
  final int requests;
}

/// Project attribution for a window.
class UsageReportProjects {
  /// Creates a projects facet.
  const UsageReportProjects({
    required this.rows,
    required this.namesIncluded,
    this.unattributedTokens,
    this.attributedCount,
  });

  /// Decodes a projects facet.
  factory UsageReportProjects.fromJson(Map<String, dynamic> json) {
    final unattributed = json['unattributed'];
    return UsageReportProjects(
      rows: _objectList(
        json['rows'],
      ).map(UsageReportProjectRow.fromJson).toList(growable: false),
      namesIncluded: json['namesIncluded'] != false,
      unattributedTokens: unattributed is Map<String, dynamic>
          ? _doubleOrZero(unattributed['tokens'])
          : null,
      attributedCount: _optionalInt(json['attributedCount']),
    );
  }

  /// Rows, token-ranked as Tokdash served them.
  ///
  /// Shown exactly as returned. Two rows that are obviously one codebase stay
  /// two rows: merging `code_anywhere` and `code_anywhere_client` on a name
  /// heuristic would fabricate a number, and the printed grouping note carries
  /// the truth instead.
  final List<UsageReportProjectRow> rows;

  /// Tokens Tokdash could attribute to no project *within the facet*.
  ///
  /// Not the whole shortfall against the period — see
  /// [UsageProjectReconciliation].
  final double? unattributedTokens;

  /// How many projects Tokdash attributed.
  final int? attributedCount;

  /// Whether real project names are present, as opposed to anonymized
  /// placeholders.
  final bool namesIncluded;
}

/// How completely a project list accounts for its period, in three parts that
/// sum to one.
///
/// The projects facet does not cover the period total. Sources with no stored
/// session records to join on — OpenClaw and the live-only tools — contribute
/// tokens and no project row at all: 10.15% of tokens at year-to-date scope on
/// the design host, against an in-facet unattributed bucket of 0.57%. Printing
/// only the unattributed bucket therefore implies 99.4% accountability where
/// the real figure is 89.8%, which is the defect this type exists to make
/// unrepeatable.
///
/// Every project surface prints all three components, and every one of them
/// comes from here rather than from a literal, so the list is visibly whole.
class UsageProjectReconciliation {
  const UsageProjectReconciliation._({
    required this.namedShare,
    required this.unattributedShare,
    required this.gapShare,
  });

  /// Computes the reconciliation of [projects] against a period total of
  /// [totalTokens].
  ///
  /// Returns `null` when there is nothing to reconcile — no facet, or an empty
  /// period — because a share of zero tokens is undefined, not 0%.
  static UsageProjectReconciliation? of(
    UsageReportProjects? projects,
    double totalTokens,
  ) {
    if (projects == null || totalTokens <= 0) return null;
    final named = projects.rows.fold<double>(0, (sum, row) => sum + row.tokens);
    final unattributed = projects.unattributedTokens ?? 0;
    // Clamped because the three upstream figures are separately rounded sums
    // over the same scan, and a window where they cross by a hair must not
    // render a negative share.
    final namedShare = (named / totalTokens).clamp(0.0, 1.0);
    final unattributedShare = (unattributed / totalTokens).clamp(
      0.0,
      1.0 - namedShare,
    );
    return UsageProjectReconciliation._(
      namedShare: namedShare,
      unattributedShare: unattributedShare,
      // Taken as the remainder rather than computed independently, so the three
      // always sum to exactly one and the printed list cannot appear to leak or
      // over-count.
      gapShare: 1.0 - namedShare - unattributedShare,
    );
  }

  /// Share of the period in named project rows, 0..1.
  final double namedShare;

  /// Share in the facet's own unattributed bucket, 0..1.
  final double unattributedShare;

  /// Share in no facet row whatsoever, 0..1.
  ///
  /// Sources without stored session records: OpenClaw and the live-only tools.
  final double gapShare;
}

/// Consecutive-day activity, as served.
class UsageReportStreaks {
  /// Creates a streaks facet.
  const UsageReportStreaks({
    this.currentStreak,
    this.longestStreak,
    this.activeDays,
    this.totalDays,
  });

  /// Decodes a streaks facet.
  factory UsageReportStreaks.fromJson(Map<String, dynamic> json) =>
      UsageReportStreaks(
        currentStreak: _optionalInt(json['currentStreak']),
        longestStreak: _optionalInt(json['longestStreak']),
        activeDays: _optionalInt(json['activeDays']),
        totalDays: _optionalInt(json['totalDays']),
      );

  /// Current consecutive active days.
  final int? currentStreak;

  /// Longest consecutive run in the window.
  final int? longestStreak;

  /// Days with any activity.
  final int? activeDays;

  /// Days in the window.
  final int? totalDays;
}

/// Window landmarks.
class UsageReportFirsts {
  /// Creates a firsts facet.
  const UsageReportFirsts({
    this.firstActiveDay,
    this.lastActiveDay,
    this.busiestDay,
    this.busiestDayTokens,
  });

  /// Decodes a firsts facet.
  factory UsageReportFirsts.fromJson(Map<String, dynamic> json) =>
      UsageReportFirsts(
        firstActiveDay: _optionalString(json['firstActiveDay']),
        lastActiveDay: _optionalString(json['lastActiveDay']),
        busiestDay: _optionalString(json['busiestDay']),
        busiestDayTokens: _optionalDouble(json['busiestDayTokens']),
      );

  /// First day with activity inside the window.
  ///
  /// Load-bearing for honest framing: on the design host it is well inside a
  /// 365-day window, so the year card says "year to date" over a printed range
  /// rather than implying twelve months.
  final String? firstActiveDay;

  /// Last day with activity inside the window.
  final String? lastActiveDay;

  /// The heaviest day.
  final String? busiestDay;

  /// Tokens on [busiestDay]. Printed beside the heatmap, which shades by rank
  /// and cannot show it.
  final double? busiestDayTokens;
}

/// How many sources the figures were drawn from.
class UsageReportCoverage {
  /// Creates a coverage block.
  const UsageReportCoverage({
    required this.storedSources,
    required this.liveSources,
    required this.sourceCount,
  });

  /// Decodes a coverage block.
  factory UsageReportCoverage.fromJson(Map<String, dynamic> json) =>
      UsageReportCoverage(
        storedSources: _stringList(json['storedSources']),
        liveSources: _stringList(json['liveSources']),
        sourceCount: _intOrZero(json['sourceCount']),
      );

  /// Sources with stored session records.
  final List<String> storedSources;

  /// Live-only sources. These contribute tokens and no project rows.
  final List<String> liveSources;

  /// Total sources, derived broker-side from the two lists.
  final int sourceCount;

  /// Whether any source exists at all.
  bool get isEmpty => sourceCount == 0;
}

/// The aggregated usage report for one window.
class UsageReport {
  /// Creates a report.
  const UsageReport({
    required this.range,
    required this.totals,
    required this.tools,
    required this.topModelsByTokens,
    required this.topModelsByCost,
    required this.sourceErrors,
    this.timezone,
    this.comparison,
    this.activeTime,
    this.hourly,
    this.weekday,
    this.daily,
    this.projects,
    this.streaks,
    this.firsts,
    this.coverage,
    this.insightsUnavailable,
    this.projectsUnavailable,
  });

  /// Decodes a report.
  factory UsageReport.fromJson(Map<String, dynamic> json) {
    T? section<T>(String key, T Function(Map<String, dynamic>) decode) {
      final value = json[key];
      return value is Map<String, dynamic> ? decode(value) : null;
    }

    final daily = json['daily'];
    return UsageReport(
      range:
          section('range', UsageReportRange.fromJson) ??
          const UsageReportRange(from: '', to: '', recognized: false),
      totals:
          section('totals', UsageReportTotals.fromJson) ??
          const UsageReportTotals(tokens: 0, cost: 0, requests: 0),
      tools: _objectList(
        json['tools'],
      ).map(UsageReportTool.fromJson).toList(growable: false),
      topModelsByTokens: _objectList(
        json['topModelsByTokens'],
      ).map(UsageReportModel.fromJson).toList(growable: false),
      topModelsByCost: _objectList(
        json['topModelsByCost'],
      ).map(UsageReportModel.fromJson).toList(growable: false),
      sourceErrors: _stringList(json['sourceErrors']),
      timezone: _optionalString(json['timezone']),
      comparison: section('comparison', UsageReportComparison.fromJson),
      activeTime: section('activeTime', UsageReportActiveTime.fromJson),
      hourly: section('hourly', UsageReportHourly.fromJson),
      weekday: section('weekday', UsageReportWeekday.fromJson),
      daily: daily is List
          ? _objectList(daily)
                .map(UsageReportDay.fromJson)
                .toList(
                  growable: false,
                )
          : null,
      projects: section('projects', UsageReportProjects.fromJson),
      streaks: section('streaks', UsageReportStreaks.fromJson),
      firsts: section('firsts', UsageReportFirsts.fromJson),
      coverage: section('coverage', UsageReportCoverage.fromJson),
      insightsUnavailable: UsageInsightsRefusal.fromJson(
        json['insightsUnavailable'],
      ),
      projectsUnavailable: UsageProjectsRefusal.fromJson(
        json['projectsUnavailable'],
      ),
    );
  }

  /// The resolved window.
  final UsageReportRange range;

  /// The broker host's zone label. The hourly and weekday buckets are cut in
  /// it.
  final String? timezone;

  /// Period totals.
  final UsageReportTotals totals;

  /// Movement against the prior window.
  final UsageReportComparison? comparison;

  /// Estimated activity time.
  final UsageReportActiveTime? activeTime;

  /// Per-tool rows, token-descending.
  final List<UsageReportTool> tools;

  /// Top models by tokens, in the order Tokdash served them.
  final List<UsageReportModel> topModelsByTokens;

  /// Top models by cost, in the order Tokdash served them.
  final List<UsageReportModel> topModelsByCost;

  /// Hour-of-day facet, or `null` when the insights scan is unavailable.
  final UsageReportHourly? hourly;

  /// Weekday facet, or `null`.
  final UsageReportWeekday? weekday;

  /// Per-day facet, or `null`.
  final List<UsageReportDay>? daily;

  /// Projects facet, or `null`.
  final UsageReportProjects? projects;

  /// Streaks facet, or `null`.
  final UsageReportStreaks? streaks;

  /// Landmarks facet, or `null`.
  final UsageReportFirsts? firsts;

  /// Source coverage, or `null`.
  final UsageReportCoverage? coverage;

  /// Tools Tokdash could not read; their usage is absent from [totals].
  final List<String> sourceErrors;

  /// Why the facets are absent, when they are.
  final UsageInsightsRefusal? insightsUnavailable;

  /// Why the project facet alone is absent, when it is.
  final UsageProjectsRefusal? projectsUnavailable;

  /// Whether project names were withheld rather than simply unavailable.
  bool get projectsWithheld => projectsUnavailable != null;

  /// The period reconciliation for the projects facet, or `null` when there is
  /// nothing to sum.
  UsageProjectReconciliation? get projectReconciliation =>
      UsageProjectReconciliation.of(projects, totals.tokens);

  /// Whether the window has any recorded activity.
  bool get isEmpty => totals.tokens <= 0 && totals.requests <= 0;

  /// Whether a partial read means some tools are missing from the totals.
  bool get isPartial => sourceErrors.isNotEmpty;

  /// Whether the "when you work" section has data.
  ///
  /// Only that section collapses when the facets are absent; the rest of the
  /// report still renders.
  bool get hasWhenYouWork =>
      (hourly?.buckets.isNotEmpty ?? false) ||
      (weekday?.buckets.isNotEmpty ?? false);
}

/// Response for `GET /api/tokdash/report`.
class UsageReportResponse {
  /// Creates a response.
  const UsageReportResponse({
    this.ok,
    this.baseUrl,
    this.cachedAt,
    this.servedFromCache,
    this.data,
    this.error,
  });

  /// Decodes a response.
  factory UsageReportResponse.fromJson(Map<String, dynamic> json) {
    final data = json['data'];
    return UsageReportResponse(
      ok: json['ok'] as bool?,
      baseUrl: _optionalString(json['baseUrl']),
      cachedAt: _optionalInt(json['cachedAt']),
      servedFromCache: json['servedFromCache'] as bool?,
      data: data is Map<String, dynamic> ? UsageReport.fromJson(data) : null,
      error: _optionalString(json['error']),
    );
  }

  /// Whether the broker served a report.
  final bool? ok;

  /// Normalized Tokdash base URL. Diagnostic only — never rendered.
  final String? baseUrl;

  /// When the broker built this window, in epoch milliseconds.
  final int? cachedAt;

  /// Whether the broker answered from its window cache.
  final bool? servedFromCache;

  /// The report, or `null` when the read failed.
  final UsageReport? data;

  /// Broker error string. Diagnostic only — never rendered, like the quota
  /// panel's.
  final String? error;

  /// The report when one was actually served, and `null` otherwise.
  ///
  /// `null` means unavailable, and the whole surface hides on it rather than
  /// rendering zeros.
  UsageReport? get report => ok == false ? null : data;
}
