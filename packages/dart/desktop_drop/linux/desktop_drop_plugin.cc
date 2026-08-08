#include "include/desktop_drop/desktop_drop_plugin.h"

#include <flutter_linux/flutter_linux.h>
#include <gtk/gtk.h>
#include <stdlib.h>
#include <sys/utsname.h>

#define DESKTOP_DROP_PLUGIN(obj) \
  (G_TYPE_CHECK_INSTANCE_CAST((obj), desktop_drop_plugin_get_type(), \
                              DesktopDropPlugin))

struct _DesktopDropPlugin {
  GObject parent_instance;
};

static gboolean isKDE = FALSE;
static gboolean ignoreNext = FALSE;

// Fork addition. Largest number of URIs one drop may deliver; negative keeps
// upstream's unbounded payload. Set by the `setFileLimit` method call.
static gint64 fileLimit = -1;

G_DEFINE_TYPE(DesktopDropPlugin, desktop_drop_plugin, g_object_get_type())

// Fork addition. Returns the first `limit` deliverable URIs of a URI list, or
// nullptr when the payload is already within bounds.
//
// GTK hands the whole selection over as one blob, so the bound has to be a cut
// of that blob: nothing past it becomes a Dart string, a list entry, or a
// DropItem.
//
// It has to count what Dart will actually deliver, or the bound stops meaning
// what the caller asked for. Dart splits with `LineSplitter` — which ends a
// line at "\n", "\r\n", or a bare "\r" — and then drops the empty ones.
// Counting raw '\n' instead would let blank lines spend the budget, so an
// overflowing drop arrives under the limit and is silently accepted in part,
// and would let a '\r'-separated payload past the bound entirely.
static gchar *truncate_uri_list(const gchar *data, gint64 limit) {
  if (data == nullptr || limit < 0) {
    return nullptr;
  }
  if (limit == 0) {
    return g_strdup("");
  }
  gint64 delivered = 0;
  const gchar *line = data;
  for (const gchar *cursor = data;; cursor++) {
    if (*cursor != '\0' && *cursor != '\n' && *cursor != '\r') {
      continue;
    }
    if (cursor != line) {
      delivered++;
    }
    if (*cursor == '\0') {
      return nullptr;  // The whole payload is already within bounds.
    }
    // "\r\n" ends one line, not two.
    if (*cursor == '\r' && *(cursor + 1) == '\n') {
      cursor++;
    }
    if (delivered >= limit) {
      // Cut after this terminator, so exactly `limit` URIs survive.
      return g_strndup(data, (cursor - data) + 1);
    }
    line = cursor + 1;
  }
}

void on_drag_data_received(GtkWidget *widget, GdkDragContext *drag_context,
                           gint x, gint y, GtkSelectionData *sdata, guint info,
                           guint time, gpointer user_data) {
  auto *channel = static_cast<FlMethodChannel *>(user_data);
  auto *data = gtk_selection_data_get_data(sdata);
  const gchar *uris = data == nullptr ? "" : (const gchar *) data;
  g_autofree gchar *bounded = truncate_uri_list(uris, fileLimit);
  double point[] = {double(x), double(y)};
  auto args = fl_value_new_list();
  fl_value_append(args,
                  fl_value_new_string(bounded == nullptr ? uris : bounded));
  fl_value_append(args, fl_value_new_float_list(point, 2));
  fl_method_channel_invoke_method(channel, "performOperation_linux", args,
                                  nullptr, nullptr, nullptr);
}

void on_drag_motion(GtkWidget *widget, GdkDragContext *drag_context,
                    gint x, gint y, guint time, gpointer user_data) {
  if (ignoreNext) {
    ignoreNext = FALSE;
    return;
  }

  auto *channel = static_cast<FlMethodChannel *>(user_data);
  double point[] = {double(x), double(y)};
  g_autoptr(FlValue) args = fl_value_new_float_list(point, 2);
  fl_method_channel_invoke_method(channel, "updated", args,
                                  nullptr, nullptr, nullptr);
}

void on_drag_leave(GtkWidget *widget, GdkDragContext *drag_context, guint time, gpointer user_data) {
  auto *channel = static_cast<FlMethodChannel *>(user_data);
  fl_method_channel_invoke_method(channel, "exited", nullptr,
                                  nullptr, nullptr, nullptr);
}

// Called when a method call is received from Flutter.
static void desktop_drop_plugin_handle_method_call(
    DesktopDropPlugin *self,
    FlMethodCall *method_call) {
  // Fork addition: accept the caller's delivery bound.
  if (strcmp(fl_method_call_get_name(method_call), "setFileLimit") == 0) {
    fileLimit = -1;
    auto *args = fl_method_call_get_args(method_call);
    if (args != nullptr && fl_value_get_type(args) == FL_VALUE_TYPE_MAP) {
      auto *value = fl_value_lookup_string(args, "limit");
      if (value != nullptr && fl_value_get_type(value) == FL_VALUE_TYPE_INT) {
        fileLimit = fl_value_get_int(value);
      }
    }
    g_autoptr(FlMethodResponse) response =
        FL_METHOD_RESPONSE(fl_method_success_response_new(nullptr));
    fl_method_call_respond(method_call, response, nullptr);
    return;
  }
  fl_method_call_respond_not_implemented(method_call, nullptr);
}

static void desktop_drop_plugin_dispose(GObject *object) {
  G_OBJECT_CLASS(desktop_drop_plugin_parent_class)->dispose(object);
}

static void desktop_drop_plugin_class_init(DesktopDropPluginClass *klass) {
  G_OBJECT_CLASS(klass)->dispose = desktop_drop_plugin_dispose;
}

static void desktop_drop_plugin_init(DesktopDropPlugin *self) {
  const char * desktopEnv = getenv("XDG_CURRENT_DESKTOP");
  if (desktopEnv) {
    const char * lowercaseDesktopEnv = g_ascii_strdown(desktopEnv, -1);

    if (strcmp(lowercaseDesktopEnv, "kde") == 0 || strcmp(lowercaseDesktopEnv, "plasma") == 0) {
        isKDE = TRUE;
    }
  }
}

static gboolean on_focus_in_event(GtkWidget *widget, GdkEventFocus *event, gpointer user_data) {
  if (isKDE) {
    ignoreNext = TRUE;
  }
  return FALSE;
}

static void method_call_cb(FlMethodChannel *channel, FlMethodCall *method_call,
                           gpointer user_data) {
  DesktopDropPlugin *plugin = DESKTOP_DROP_PLUGIN(user_data);
  desktop_drop_plugin_handle_method_call(plugin, method_call);
}

void desktop_drop_plugin_register_with_registrar(FlPluginRegistrar *registrar) {
  DesktopDropPlugin *plugin = DESKTOP_DROP_PLUGIN(
      g_object_new(desktop_drop_plugin_get_type(), nullptr));

  auto *fl_view = fl_plugin_registrar_get_view(registrar);
  static GtkTargetEntry entries[] = {
      {strdup("STRING"), GTK_TARGET_OTHER_APP, 0}
  };
  gtk_drag_dest_set(GTK_WIDGET(fl_view), GTK_DEST_DEFAULT_ALL, entries, 1, GDK_ACTION_COPY);
  gtk_drag_dest_add_uri_targets(GTK_WIDGET(fl_view));

  g_autoptr(FlStandardMethodCodec) codec = fl_standard_method_codec_new();
  FlMethodChannel *channel =
      fl_method_channel_new(fl_plugin_registrar_get_messenger(registrar),
                            "desktop_drop",
                            FL_METHOD_CODEC(codec));
  fl_method_channel_set_method_call_handler(channel, method_call_cb,
                                            g_object_ref(plugin),
                                            g_object_unref);

  g_signal_connect(fl_view, "drag-motion",
                   G_CALLBACK(on_drag_motion), channel);
  g_signal_connect(GTK_WIDGET(fl_view), "drag-data-received",
                   G_CALLBACK(on_drag_data_received), channel);
  g_signal_connect(GTK_WIDGET(fl_view), "drag-leave",
                   G_CALLBACK(on_drag_leave), channel);
  g_signal_connect(fl_view, "focus-in-event",
                   G_CALLBACK(on_focus_in_event), nullptr);

  g_object_unref(plugin);
}
