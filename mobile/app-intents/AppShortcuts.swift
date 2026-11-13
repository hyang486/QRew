import AppIntents

/// Spec 10.5. Every phrase must contain \(.applicationName) ("Qrew") plus other words.
/// "Hey Siri, Qrewing" would need INAlternativeAppNames and a device check (human item); not set here.
struct AppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskQrewIntent(),
      phrases: [
        "Ask \(.applicationName)",
        "Ask \(.applicationName) a question",
      ],
      shortTitle: "Ask Qrewing",
      systemImageName: "bubble.left.and.text.bubble.right"
    )
  }
}
