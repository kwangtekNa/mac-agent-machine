import SwiftUI

/// 첫 실행 화면. Mac 서버 주소를 입력해 `/me` 로 확인한다.
struct ConnectView: View {
    @Environment(AppState.self) private var appState
    @State private var model: ConnectModel?

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    ConnectForm(model: model)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Mac 서버에 연결")
        }
        .onAppear {
            if model == nil { model = ConnectModel(savedConfig: appState.configStore.config) }
        }
    }
}

private struct ConnectForm: View {
    @Environment(AppState.self) private var appState
    @Bindable var model: ConnectModel
    @FocusState private var addressFocused: Bool

    var body: some View {
        Form {
            Section {
                TextField("https://macmini.tailnet.ts.net", text: $model.address)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .submitLabel(.go)
                    .focused($addressFocused)
                    .onSubmit { submit() }
                    .accessibilityLabel("서버 주소")
                if let message = errorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .accessibilityLabel("연결 오류: \(message)")
                }
            } header: {
                Text("Tailscale에 연결된 Mac의 주소를 입력하세요")
                    .textCase(nil)
            }

            Section {
                Button {
                    submit()
                } label: {
                    HStack {
                        Text("연결")
                        if model.isSubmitting {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(!model.canSubmit)
                #if targetEnvironment(simulator)
                Button("개발 서버(127.0.0.1:7777)에 연결") {
                    model.address = ConnectModel.devServerAddress
                    submit()
                }
                .disabled(model.isSubmitting)
                #endif
            }
        }
        .onAppear { addressFocused = model.address.isEmpty }
    }

    /// 입력 검증 실패가 우선, 그다음 마지막 연결 실패 이유.
    private var errorMessage: String? {
        if let validation = model.validationMessage { return validation }
        if case .failed(let message) = appState.connection { return message }
        return nil
    }

    private func submit() {
        guard model.canSubmit else { return }
        let appState = self.appState
        Task { await model.submit(using: appState) }
    }
}

#Preview {
    ConnectView()
        .environment(AppState())
}
