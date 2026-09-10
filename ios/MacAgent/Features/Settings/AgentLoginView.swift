import SwiftUI
import UIKit

/// 에이전트 로그인 시트. Claude 는 URL + 코드 입력, Codex 는 URL + 표시된 코드 입력(ADR-008).
struct AgentLoginView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var model: LoginFlowModel?
    let agent: AgentKind

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    LoginFlowContent(model: model, openURL: openURL)
                } else {
                    ProgressView("로그인을 준비하는 중…")
                }
            }
            .navigationTitle(Text("\(agent.displayName) 로그인"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("닫기") { dismiss() }
                }
            }
        }
        .task {
            guard model == nil, let client = appState.client else { return }
            let created = LoginFlowModel(agent: agent, client: client)
            model = created
            await created.begin()
        }
        .onChange(of: model?.phase) { _, phase in
            guard case .done = phase else { return }
            let appState = self.appState
            Task {
                await appState.refreshMe()
                dismiss()
            }
        }
        .onDisappear { model?.stop() }
    }
}

private struct LoginFlowContent: View {
    @Bindable var model: LoginFlowModel
    let openURL: OpenURLAction
    @State private var copiedNotice: String?

    var body: some View {
        switch model.phase {
        case .starting:
            ProgressView("로그인을 준비하는 중…")
        case .waiting:
            waitingForm
        case .done(let message):
            ContentUnavailableView {
                Label("로그인 완료", systemImage: "checkmark.circle.fill")
            } description: {
                Text(message)
            }
        case .failed(let message):
            ContentUnavailableView {
                Label("로그인하지 못했습니다", systemImage: "exclamationmark.triangle.fill")
            } description: {
                Text(message)
            } actions: {
                Button("다시 시도") { Task { await model.retry() } }
                    .buttonStyle(.borderedProminent)
            }
        case .unsupported(let message):
            ContentUnavailableView {
                Label("앱 로그인을 지원하지 않습니다", systemImage: "terminal")
            } description: {
                Text(message)
            }
        }
    }

    private var waitingForm: some View {
        Form {
            if let start = model.start {
                Section {
                    if let code = model.displayedCode {
                        Text(code)
                            .font(.system(.largeTitle, design: .monospaced))
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity)
                            .textSelection(.enabled)
                            .accessibilityLabel("로그인 코드 \(code)")
                    }
                    Text(start.instructions)
                        .font(model.displayedCode == nil ? .body : .subheadline)
                        .textSelection(.enabled)
                }

                Section {
                    if let url = model.loginURL {
                        Button {
                            openURL(url)
                        } label: {
                            Label("링크 열기", systemImage: "safari")
                        }
                    }
                    Button {
                        copy(start.url, notice: String(localized: "링크를 복사했습니다"))
                    } label: {
                        Label("링크 복사", systemImage: "doc.on.doc")
                    }
                    if let code = model.displayedCode {
                        Button {
                            copy(code, notice: String(localized: "코드를 복사했습니다"))
                        } label: {
                            Label("코드 복사", systemImage: "number")
                        }
                    }
                    if let copiedNotice {
                        Text(copiedNotice)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if start.needsCode {
                    Section {
                        TextField("브라우저에 표시된 코드", text: $model.code)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.send)
                            .onSubmit { submitCode() }
                            .accessibilityLabel("로그인 코드")
                        if let message = model.codeMessage {
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                        Button {
                            submitCode()
                        } label: {
                            HStack {
                                Text("코드 제출")
                                if model.isSubmittingCode {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(!model.canSubmitCode)
                    } header: {
                        Text("브라우저에서 로그인한 뒤 받은 코드를 붙여넣으세요")
                            .textCase(nil)
                    }
                }

                Section {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text("브라우저에서 로그인을 마치면 자동으로 완료됩니다.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func submitCode() {
        guard model.canSubmitCode else { return }
        Task { await model.submitCode() }
    }

    private func copy(_ text: String, notice: String) {
        UIPasteboard.general.string = text
        copiedNotice = notice
    }
}
