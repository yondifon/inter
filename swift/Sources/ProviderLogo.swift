import SwiftUI

/// Brand mark for a CLI provider, falling back to an SF Symbol where no mark ships.
struct ProviderLogo: View {
    let provider: Provider
    var size: CGFloat = 16

    var body: some View {
        Group {
            if let mark = ProviderMark.paths[provider] {
                SVGPath(data: mark).fill(style: FillStyle(eoFill: true))
            } else {
                Image(systemName: provider.symbol).resizable().scaledToFit()
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(provider.label)
    }
}
