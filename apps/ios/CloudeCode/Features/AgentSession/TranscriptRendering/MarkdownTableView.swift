import MarkdownParsing
import SwiftUI

extension MarkdownPartsView {
    /// A table cell paired with the column index it starts at.
    struct CellPlacement: Identifiable {
        let id: Int
        let cell: MarkdownTable.Cell
    }

    /// Caps the width proposed to a table cell so long content wraps and reports its wrapped height.
    ///
    /// `frame(maxWidth:)` clamps a cell's reported size but forwards the horizontal scroll view's
    /// unspecified width proposal to the text untouched, so long cells measured at their ideal size
    /// report a single-line height while rendering wrapped — overlapping the rows below.
    struct WidthCappedCellLayout: Layout {
        let maximumWidth: CGFloat
        let alignment: MarkdownTable.ColumnAlignment

        func sizeThatFits(
            proposal: ProposedViewSize,
            subviews: Subviews,
            cache: inout ()
        ) -> CGSize {
            guard let subview = subviews.first else {
                return .zero
            }
            let cappedWidth = min(proposal.width ?? maximumWidth, maximumWidth)
            let idealSize = subview.sizeThatFits(.unspecified)
            guard idealSize.width > cappedWidth else {
                return idealSize
            }
            let wrappedSize = subview.sizeThatFits(ProposedViewSize(width: cappedWidth, height: nil))

            // Report the full capped width, not the wrapped text's extent, so the resolved column
            // never proposes a narrower width that would re-wrap the text taller than measured.
            return CGSize(width: cappedWidth, height: wrappedSize.height)
        }

        func placeSubviews(
            in bounds: CGRect,
            proposal: ProposedViewSize,
            subviews: Subviews,
            cache: inout ()
        ) {
            guard let subview = subviews.first else {
                return
            }
            let childProposal = ProposedViewSize(width: min(bounds.width, maximumWidth), height: nil)
            let (anchor, x): (UnitPoint, CGFloat) = switch alignment {
            case .leading: (.topLeading, bounds.minX)
            case .center: (.top, bounds.midX)
            case .trailing: (.topTrailing, bounds.maxX)
            }
            subview.place(at: CGPoint(x: x, y: bounds.minY), anchor: anchor, proposal: childProposal)
        }
    }

    /// Renders a GitHub-flavored Markdown table as a horizontally scrollable grid.
    struct TableView: View {
        @Environment(\.theme) private var theme
        @Environment(\.style) private var style

        /// Cells wrap instead of growing without bound inside the horizontal scroll view.
        private static let maximumCellWidth: CGFloat = 220

        let table: MarkdownTable

        var body: some View {
            ScrollView(.horizontal) {
                Grid(
                    alignment: .topLeading,
                    horizontalSpacing: style.gridSize * 1.5,
                    verticalSpacing: style.gridSize
                ) {
                    if let header = table.header {
                        rowView(header, isHeader: true, definesColumnAlignment: true)
                        DividerView()
                            .gridCellUnsizedAxes(.horizontal)
                    }
                    ForEach(Array(table.rows.enumerated()), id: \.offset) { offset, row in
                        rowView(
                            row,
                            isHeader: false,
                            definesColumnAlignment: table.header == nil && offset == 0
                        )
                    }
                }
                .padding(.trailing, style.gridSize)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        private func rowView(
            _ row: MarkdownTable.Row,
            isHeader: Bool,
            definesColumnAlignment: Bool
        ) -> some View {
            GridRow {
                ForEach(placements(in: row)) { placement in
                    cellView(
                        placement.cell,
                        column: placement.id,
                        isHeader: isHeader,
                        definesColumnAlignment: definesColumnAlignment
                    )
                }
            }
        }

        @ViewBuilder
        private func cellView(
            _ cell: MarkdownTable.Cell,
            column: Int,
            isHeader: Bool,
            definesColumnAlignment: Bool
        ) -> some View {
            let alignment = table.alignment(forColumn: column)
            let content = WidthCappedCellLayout(maximumWidth: Self.maximumCellWidth, alignment: alignment) {
                Text(cell.content)
                    .font(style.responseTextFont)
                    .fontWeight(isHeader ? .semibold : nil)
                    .foregroundStyle(isHeader ? theme.secondaryLabelColor : theme.labelColor)
                    .multilineTextAlignment(textAlignment(for: alignment))
            }
            .gridCellColumns(cell.columnSpan)

            // A column takes its alignment from a single non-spanning cell in one row.
            if definesColumnAlignment, cell.columnSpan == 1 {
                content.gridColumnAlignment(horizontalAlignment(for: alignment))
            } else {
                content
            }
        }

        /// Pairs each cell with its starting column so spanning cells keep later columns aligned.
        private func placements(in row: MarkdownTable.Row) -> [CellPlacement] {
            var column = 0

            return row.cells.map { cell in
                defer { column += cell.columnSpan }

                return CellPlacement(id: column, cell: cell)
            }
        }

        private func textAlignment(for alignment: MarkdownTable.ColumnAlignment) -> TextAlignment {
            switch alignment {
            case .leading: .leading
            case .center: .center
            case .trailing: .trailing
            }
        }

        private func horizontalAlignment(
            for alignment: MarkdownTable.ColumnAlignment
        ) -> HorizontalAlignment {
            switch alignment {
            case .leading: .leading
            case .center: .center
            case .trailing: .trailing
            }
        }
    }
}
