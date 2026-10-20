import 'package:flutter/widgets.dart';

/// Owns execution, not just painting. Inactive documents are never pooled.
/// Hosts retain sessions under TickerMode, but dispose unselected file panes.
abstract class HtmlDocumentState<T extends StatefulWidget> extends State<T>
    with WidgetsBindingObserver {
  bool _foreground = true;

  /// Whether visibility and app lifecycle currently allow execution.
  bool documentActive = false;

  /// Invalidates asynchronous setup, callbacks and cleanup.
  int documentGeneration = 0;

  /// Acquires one document for this visibility generation.
  void startDocument(int generation);

  /// Starts destruction immediately; native completion is asynchronous.
  void stopDocument();

  /// Whether an asynchronous result still belongs to the visible document.
  bool isCurrentDocument(int generation) =>
      mounted && documentActive && generation == documentGeneration;

  @override
  void initState() {
    super.initState();
    _foreground = _isForeground(WidgetsBinding.instance.lifecycleState);
    WidgetsBinding.instance.addObserver(this);
  }

  // Losing focus (inactive) does not hide a desktop/browser document.
  bool _isForeground(AppLifecycleState? state) =>
      state != AppLifecycleState.hidden &&
      state != AppLifecycleState.paused &&
      state != AppLifecycleState.detached;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncActivity();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = _isForeground(state);
    if (mounted) setState(_syncActivity);
  }

  void _syncActivity() {
    final active =
        _foreground &&
        TickerMode.valuesOf(context).enabled &&
        (ModalRoute.isCurrentOf(context) ?? true);
    if (active == documentActive) return;
    documentActive = active;
    documentGeneration++;
    if (active) {
      startDocument(documentGeneration);
    } else {
      // This runs before a frame: hiding a Flutter subtree cannot stop JS.
      stopDocument();
    }
  }

  /// Retires the previous revision and creates the current visible one.
  void replaceDocument() {
    documentGeneration++;
    stopDocument();
    if (documentActive) startDocument(documentGeneration);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    documentActive = false;
    documentGeneration++;
    stopDocument();
    super.dispose();
  }
}
