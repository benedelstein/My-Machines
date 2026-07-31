import AuthenticationServices
import SwiftUI

/// Login screen: app identity centered, GitHub sign-in pinned to the bottom.
struct SignedOutView: View {
    @Environment(\.showToast) private var showToast: ShowToastAction?
    @Environment(\.webAuthenticationSession)
    private var webAuthenticationSession: WebAuthenticationSession

    let sessionStore: SessionStore

    var body: some View {
        ZStack {
            SignedOutStyle.backgroundGradient
                .ignoresSafeArea()

            SignedOutHero()
                .offset(y: SignedOutStyle.wordmarkVerticalOffset)

            VStack {
                Spacer()

                Button {
                    Task { await sessionStore.signIn(using: webAuthenticationSession) }
                } label: {
                    ZStack {
                        if sessionStore.isSigningIn {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Sign in")
                        }
                    }
                    .font(SignedOutStyle.signInFont)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: SignedOutStyle.signInButtonHeight)
                    .contentShape(Capsule())
                    .glassBackground(in: .capsule, glass: .clear)
                }
                .disabled(sessionStore.isSigningIn)
                .padding(.horizontal, SignedOutStyle.horizontalPadding)
                .padding(.bottom, SignedOutStyle.bottomPadding)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: sessionStore.signInError) { _, error in
            guard let error else {
                return
            }
            showToast?(
                title: Text(verbatim: error),
                icon: Image(systemName: "exclamationmark.circle.fill")
            )
        }
    }
}

private struct SignedOutHero: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion: Bool
    @State private var visibleKickerCharacterCount: Int = 0
    @State private var isSubtitleVisible: Bool = false

    private let kicker: String = String(localized: "Works on")

    var body: some View {
        ZStack {
            Wordmark()

            typewriterKicker
                .offset(y: SignedOutStyle.kickerVerticalOffset)
                .task {
                    await animateKicker()
                }

            Text("Infinite, on-demand computers for all your work.")
                .font(SignedOutStyle.subtitleFont)
                .foregroundStyle(SignedOutStyle.subtitleColor)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .opacity(isSubtitleVisible ? 1 : 0)
                .blur(radius: isSubtitleVisible ? 0 : SignedOutStyle.copyBlurRadius)
                .offset(
                    y: SignedOutStyle.subtitleVerticalOffset
                        + (isSubtitleVisible ? 0 : SignedOutStyle.copyHiddenVerticalOffset)
                )
                .padding(.horizontal, SignedOutStyle.subtitleHorizontalPadding)
                .task {
                    await animateSubtitle()
                }
        }
    }

    private var typewriterKicker: some View {
        ZStack(alignment: .leading) {
            Text(kicker)
                .hidden()

            Text(String(kicker.prefix(visibleKickerCharacterCount)))
        }
        .font(SignedOutStyle.kickerFont)
        .foregroundStyle(.white)
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(kicker))
    }

    @MainActor
    private func animateKicker() async {
        guard !reduceMotion else {
            visibleKickerCharacterCount = kicker.count
            return
        }
        guard await wait(milliseconds: SignedOutStyle.kickerRevealDelayMilliseconds) else {
            return
        }

        for characterCount in 1...kicker.count {
            visibleKickerCharacterCount = characterCount

            guard characterCount < kicker.count else {
                return
            }
            guard await wait(milliseconds: SignedOutStyle.kickerCharacterDelayMilliseconds) else {
                return
            }
        }
    }

    @MainActor
    private func animateSubtitle() async {
        guard !reduceMotion else {
            isSubtitleVisible = true
            return
        }
        guard await wait(milliseconds: SignedOutStyle.subtitleRevealDelayMilliseconds) else {
            return
        }

        withAnimation(.easeOut(duration: SignedOutStyle.copyRevealDuration)) {
            isSubtitleVisible = true
        }
    }

    @MainActor
    private func wait(milliseconds: Int) async -> Bool {
        do {
            try await Task.sleep(for: .milliseconds(milliseconds))
            return !Task.isCancelled
        } catch {
            return false
        }
    }
}

private enum SignedOutStyle {
    static let wordmarkVerticalOffset: CGFloat = -25
    static let kickerVerticalOffset: CGFloat = -57
    static let subtitleVerticalOffset: CGFloat = 70
    static let subtitleHorizontalPadding: CGFloat = 20
    static let copyBlurRadius: CGFloat = 8
    static let copyHiddenVerticalOffset: CGFloat = 4
    static let kickerRevealDelayMilliseconds: Int = 100
    static let kickerCharacterDelayMilliseconds: Int = 70
    static let subtitleRevealDelayMilliseconds: Int = 1_225
    static let copyRevealDuration: Double = 0.25
    static let horizontalPadding: CGFloat = 16
    static let signInButtonHeight: CGFloat = 56
    static let bottomPadding: CGFloat = 4
    static let signInButtonTint: Color = Color(hex: 0x102A5A)
    static let signInFont: Font = Font.semibold(20)
    static let kickerFont: Font = Font.custom("Schoolbell-Regular", size: 21)
    static let subtitleFont: Font = Font.system(size: 16)
    static let subtitleColor: Color = Color(hex: 0xAEB8CF)
    static let backgroundGradient: LinearGradient = LinearGradient(
        colors: [Color(hex: 0x08122F), Color(hex: 0x040B22)],
        startPoint: .top,
        endPoint: .bottom
    )
}
