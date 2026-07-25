import MarkdownParsing
import SwiftUI

extension MarkdownPartsView {
    /// A table cell paired with the column index it starts at.
    struct CellPlacement: Identifiable {
        let id: Int
        let cell: MarkdownTable.Cell
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
            let content = Text(cell.content)
                .font(style.responseTextFont)
                .fontWeight(isHeader ? .semibold : nil)
                .foregroundStyle(isHeader ? theme.secondaryLabelColor : theme.labelColor)
                .multilineTextAlignment(textAlignment(for: alignment))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: Self.maximumCellWidth, alignment: frameAlignment(for: alignment))
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

        private func frameAlignment(for alignment: MarkdownTable.ColumnAlignment) -> Alignment {
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
