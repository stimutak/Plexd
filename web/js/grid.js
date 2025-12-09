/**
 * Plexd Smart Grid Layout Engine
 *
 * Calculates optimal grid layouts for multiple video streams,
 * maximizing video area while minimizing wasted space.
 */

const PlexdGrid = (function() {
    'use strict';

    /**
     * Calculate the optimal grid layout for given streams and container
     * @param {Object} container - {width, height} of the container
     * @param {Array} streams - Array of stream objects with aspect ratios
     * @returns {Object} Layout configuration with cell positions and sizes
     */
    function calculateLayout(container, streams) {
        const count = streams.length;

        if (count === 0) {
            return { cells: [], rows: 0, cols: 0 };
        }

        if (count === 1) {
            return singleStreamLayout(container, streams[0]);
        }

        // Find optimal grid dimensions
        const gridDimensions = findOptimalGrid(container, count);

        // Calculate cell sizes and positions
        return buildGridLayout(container, streams, gridDimensions);
    }

    /**
     * Layout for a single stream - maximize to container
     */
    function singleStreamLayout(container, stream) {
        const aspectRatio = stream.aspectRatio || 16/9;
        const fit = fitToContainer(container, aspectRatio);

        return {
            cells: [{
                streamId: stream.id,
                x: (container.width - fit.width) / 2,
                y: (container.height - fit.height) / 2,
                width: fit.width,
                height: fit.height
            }],
            rows: 1,
            cols: 1,
            efficiency: calculateEfficiency(container, [fit])
        };
    }

    /**
     * Find optimal grid dimensions (rows x cols) for n streams
     * Optimizes for minimal wasted space given container aspect ratio
     */
    function findOptimalGrid(container, count) {
        const containerRatio = container.width / container.height;
        let bestLayout = { rows: 1, cols: count, score: -Infinity };

        // Try all possible row/col combinations
        for (let rows = 1; rows <= count; rows++) {
            const cols = Math.ceil(count / rows);

            // Skip if we'd have too many empty cells
            const emptyCells = (rows * cols) - count;
            if (emptyCells >= cols) continue;

            // Calculate cell dimensions
            const cellWidth = container.width / cols;
            const cellHeight = container.height / rows;
            const cellRatio = cellWidth / cellHeight;

            // Score based on how close cell ratio is to 16:9 (common video ratio)
            // and how well it fills the space
            const targetRatio = 16 / 9;
            const ratioScore = 1 - Math.abs(cellRatio - targetRatio) / targetRatio;
            const fillScore = count / (rows * cols);
            const score = ratioScore * 0.6 + fillScore * 0.4;

            if (score > bestLayout.score) {
                bestLayout = { rows, cols, score };
            }
        }

        return bestLayout;
    }

    /**
     * Build the actual layout with positions and sizes
     */
    function buildGridLayout(container, streams, grid) {
        const { rows, cols } = grid;
        const cellWidth = container.width / cols;
        const cellHeight = container.height / rows;
        const cells = [];

        let streamIndex = 0;
        for (let row = 0; row < rows && streamIndex < streams.length; row++) {
            for (let col = 0; col < cols && streamIndex < streams.length; col++) {
                const stream = streams[streamIndex];
                const aspectRatio = stream.aspectRatio || 16/9;

                // Fit video within cell while maintaining aspect ratio
                const fit = fitToContainer(
                    { width: cellWidth, height: cellHeight },
                    aspectRatio
                );

                cells.push({
                    streamId: stream.id,
                    x: col * cellWidth + (cellWidth - fit.width) / 2,
                    y: row * cellHeight + (cellHeight - fit.height) / 2,
                    width: fit.width,
                    height: fit.height,
                    row,
                    col
                });

                streamIndex++;
            }
        }

        return {
            cells,
            rows,
            cols,
            cellWidth,
            cellHeight,
            efficiency: calculateEfficiency(container, cells)
        };
    }

    /**
     * Fit content with given aspect ratio into container
     * Returns dimensions that maintain ratio and fit within container
     */
    function fitToContainer(container, aspectRatio) {
        const containerRatio = container.width / container.height;

        if (aspectRatio > containerRatio) {
            // Video is wider than container - fit to width
            return {
                width: container.width,
                height: container.width / aspectRatio
            };
        } else {
            // Video is taller than container - fit to height
            return {
                width: container.height * aspectRatio,
                height: container.height
            };
        }
    }

    /**
     * Calculate layout efficiency (video area / total area)
     */
    function calculateEfficiency(container, cells) {
        const totalArea = container.width * container.height;
        const videoArea = cells.reduce((sum, cell) => {
            return sum + (cell.width * cell.height);
        }, 0);
        return videoArea / totalArea;
    }

    /**
     * Recalculate layout when container resizes
     * Debounced for performance
     */
    let resizeTimeout = null;
    function onContainerResize(container, streams, callback) {
        if (resizeTimeout) {
            clearTimeout(resizeTimeout);
        }
        resizeTimeout = setTimeout(() => {
            const layout = calculateLayout(container, streams);
            callback(layout);
        }, 50);
    }

    /**
     * Apply layout to DOM elements
     * @param {HTMLElement} containerEl - The grid container element
     * @param {Object} layout - Layout from calculateLayout()
     * @param {Map} videoElements - Map of streamId -> video element
     */
    function applyLayout(containerEl, layout, videoElements) {
        layout.cells.forEach(cell => {
            const videoWrapper = videoElements.get(cell.streamId);
            if (videoWrapper) {
                // Skip streams in fullscreen mode - don't override their positioning
                if (videoWrapper.classList.contains('plexd-fullscreen')) {
                    return;
                }
                videoWrapper.style.position = 'absolute';
                videoWrapper.style.left = cell.x + 'px';
                videoWrapper.style.top = cell.y + 'px';
                videoWrapper.style.width = cell.width + 'px';
                videoWrapper.style.height = cell.height + 'px';
            }
        });
    }

    // Public API
    return {
        calculateLayout,
        applyLayout,
        onContainerResize,
        fitToContainer,
        calculateEfficiency
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlexdGrid;
}
