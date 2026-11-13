import AppIntents
import Foundation
import Security

/// Spec 10.5: "Hey Siri, ask Qrew". Asks for a question, sends it to the `qrewing` Edge Function `ask` action
/// for the user's active room, and speaks the answer. Runs in the background; no JavaScript runs here.
///
/// Auth comes from the Keychain mirror that JS writes (see `SiriMirror`). Swift never refreshes the session:
/// Supabase refresh tokens are single-use, so a second refresher could sign the user out.
struct AskQrewIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask Qrewing"
  static let description = IntentDescription("Ask Qrewing a question about the room you are in.")

  /// iOS 16.4–25. Deprecated from iOS 26, where `supportedModes` below takes over.
  static let openAppWhenRun: Bool = false

  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .background }

  /// Siri may ask while the phone is locked; the Keychain item is readable after first unlock.
  static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

  @Parameter(title: "Question", requestValueDialog: IntentDialog("What do you want to ask?"))
  var question: String

  func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
    let line = await QrewingAsk.answer(question)
    return .result(value: line, dialog: IntentDialog(stringLiteral: line))
  }
}

/// The Keychain mirror written by JS with expo-secure-store (key "qrew.siri.v1", keychainService "com.qrew.siri",
/// AFTER_FIRST_UNLOCK). SecureStore appends ":no-auth" to the service and stores the key as Data.
struct SiriMirror: Decodable {
  let v: Int
  let accessToken: String
  let expiresAt: Double
  let roomId: String?
  let supabaseUrl: String
  let anonKey: String

  static let service = "com.qrew.siri:no-auth"
  static let account = "qrew.siri.v1"

  static func load() -> SiriMirror? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: Data(account.utf8),
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    guard let m = try? JSONDecoder().decode(SiriMirror.self, from: data), m.v == 1 else { return nil }
    return m
  }
}

enum QrewingAsk {
  static let signIn = "Open Qrew and sign in first."
  static let reopen = "Open Qrew once, then ask again."
  static let noRoom = "Join a room in Qrew first."
  static let failed = "Qrewing couldn't answer right now. Try again in the app."

  /// Always returns a line to speak; never throws, so Siri never shows a generic error.
  static func answer(_ raw: String, now: Date = Date()) async -> String {
    // The server counts code points (Array.from), so cut by unicode scalars, not grapheme clusters.
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    var scalars = String.UnicodeScalarView()
    scalars.append(contentsOf: trimmed.unicodeScalars.prefix(300))
    let question = String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
    if question.isEmpty { return "I didn't catch a question." }
    guard let m = SiriMirror.load() else { return signIn }
    guard m.expiresAt > now.timeIntervalSince1970 + 30 else { return reopen }
    guard let roomId = m.roomId, !roomId.isEmpty else { return noRoom }
    guard let url = URL(string: m.supabaseUrl + "/functions/v1/qrewing") else { return failed }

    var req = URLRequest(url: url, timeoutInterval: 8)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \(m.accessToken)", forHTTPHeaderField: "Authorization")
    req.setValue(m.anonKey, forHTTPHeaderField: "apikey")
    let body: [String: Any] = ["action": "ask", "roomId": roomId, "question": question, "tz": TimeZone.current.identifier]
    guard let payload = try? JSONSerialization.data(withJSONObject: body) else { return failed }
    req.httpBody = payload

    guard let (data, res) = try? await URLSession.shared.data(for: req), let http = res as? HTTPURLResponse else {
      return failed
    }
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    if http.statusCode == 200, let a = json?["answer"] as? String, !a.isEmpty { return a }
    return line(status: http.statusCode, error: json?["error"] as? String)
  }

  static func line(status: Int, error: String?) -> String {
    switch (status, error) {
    case (401, _): return reopen
    case (_, "not_member"): return "That room has ended or you are no longer in it. " + noRoom
    case (_, "ai_off"): return "Qrewing AI is off in this room."
    case (_, "not_consented"): return "Turn on Qrewing AI for this room in Qrew first."
    case (_, "ask_limit"): return "You've reached today's question limit for this room."
    default: return failed
    }
  }
}
