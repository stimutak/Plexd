/**
 * Plexd Smart Grid Layout Engine
 *
 * Calculates optimal grid layouts for multiple video streams,
 * maximizing video area while minimizing wasted space.
 * Includes "Smart Layout" mode that allows intelligent overlapping.
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

                // Apply z-index if specified (for smart layout overlapping)
                if (cell.zIndex !== undefined) {
                    videoWrapper.style.zIndex = cell.zIndex;
                }
            }
        });
    }

    // =========================================================================
    // Smart Stream Layout - Tetris-like intelligent window management
    // =========================================================================

    /**
     * Smart Stream Layout - Maximizes viewable video area by:
     * 1. Detecting letterboxing (black bars) on each video
     * 2. Allowing streams to overlap into each other's black bar zones
     * 3. Scaling and positioning to maximize screen usage
     * 4. Trying multiple layout strategies and picking the best
     *
     * @param {Object} container - {width, height} of the container
     * @param {Array} streams - Array of stream objects with aspect ratios
     * @returns {Object} Layout configuration with overlapping positions
     */
    function calculateSmartLayout(container, streams) {
        const count = streams.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, efficiency: 0, mode: 'smart' };

        // Single stream - just maximize it
        if (count === 1) {
            const layout = singleStreamLayout(container, streams[0]);
            layout.mode = 'smart';
            return layout;
        }

        // Container aspect ratio
        const containerAR = container.width / container.height;

        // Analyze each stream's characteristics
        const streamData = streams.map((stream, index) => {
            const ar = stream.aspectRatio || 16/9;
            return {
                stream,
                index,
                aspectRatio: ar,
                // Determine if this is a wide video (has top/bottom bars) or tall (has side bars)
                isWide: ar > containerAR,
                letterboxRatio: ar > containerAR
                    ? (1 - containerAR / ar) // Percentage of height that's black bars
                    : (1 - ar / containerAR)  // Percentage of width that's black bars
            };
        });

        // Try multiple layout strategies and pick the best
        const layouts = [
            trySmartOverlapLayout(container, streamData),
            tryHorizontalStackLayout(container, streamData),
            tryVerticalStackLayout(container, streamData),
            tryMosaicLayout(container, streamData),
            tryDiagonalLayout(container, streamData)
        ];

        // Pick the layout with highest efficiency
        let bestLayout = layouts[0];
        for (const layout of layouts) {
            if (layout.efficiency > bestLayout.efficiency) {
                bestLayout = layout;
            }
        }

        return bestLayout;
    }

    /**
     * Smart overlap layout - the core "Tetris-like" algorithm
     * Places videos so they overlap into each other's letterbox zones
     */
    function trySmartOverlapLayout(container, streamData) {
        const count = streamData.length;
        const cells = [];

        // Calculate base sizes - give each video a reasonable share of container
        // Use larger allocation to ensure videos are substantial
        const totalArea = container.width * container.height;
        const areaPerStream = totalArea / Math.max(1, count * 0.7); // Allocate more area per stream

        // Sort by aspect ratio - place widest first, they set the horizontal structure
        const sorted = [...streamData].sort((a, b) => b.aspectRatio - a.aspectRatio);

        // Track occupied regions (with video content, not black bars)
        const occupiedRegions = [];

        // Minimum size: ensure each video is at least this portion of container
        const minSizeRatio = count <= 2 ? 0.4 : count <= 4 ? 0.3 : 0.25;
        const minWidth = container.width * minSizeRatio;
        const minHeight = container.height * minSizeRatio;

        for (let i = 0; i < sorted.length; i++) {
            const data = sorted[i];
            const ar = data.aspectRatio;

            // Calculate ideal size based on area allocation
            let targetHeight = Math.sqrt(areaPerStream / ar);
            let targetWidth = targetHeight * ar;

            // Enforce minimum size
            if (targetWidth < minWidth) {
                targetWidth = minWidth;
                targetHeight = targetWidth / ar;
            }
            if (targetHeight < minHeight) {
                targetHeight = minHeight;
                targetWidth = targetHeight * ar;
            }

            // Scale to fit container (allow some variation but maintain minimum)
            const maxScale = 1.3;
            const minScale = 0.8; // Don't go too small

            // Try different scales to find best fit
            let bestPlacement = null;
            let bestScore = -Infinity;

            for (let scale = maxScale; scale >= minScale; scale -= 0.1) {
                const width = Math.max(targetWidth * scale, minWidth);
                const height = Math.max(targetHeight * scale, minHeight);

                // Find best position for this scaled size
                const placement = findBestPosition(
                    container, width, height, ar, occupiedRegions
                );

                if (placement && placement.score > bestScore) {
                    bestScore = placement.score;
                    bestPlacement = { ...placement, width, height };
                }
            }

            // Fallback if no good placement found - use a reasonable grid-like placement
            if (!bestPlacement) {
                // Calculate reasonable fallback size
                const cols = Math.ceil(Math.sqrt(count));
                const rows = Math.ceil(count / cols);
                const cellWidth = container.width / cols;
                const cellHeight = container.height / rows;

                const fit = fitToContainer({ width: cellWidth * 0.95, height: cellHeight * 0.95 }, ar);
                const col = i % cols;
                const row = Math.floor(i / cols);

                bestPlacement = {
                    x: col * cellWidth + (cellWidth - fit.width) / 2,
                    y: row * cellHeight + (cellHeight - fit.height) / 2,
                    width: fit.width,
                    height: fit.height,
                    score: 0
                };
            }

            cells.push({
                streamId: data.stream.id,
                x: Math.max(0, Math.min(container.width - bestPlacement.width, bestPlacement.x)),
                y: Math.max(0, Math.min(container.height - bestPlacement.height, bestPlacement.y)),
                width: bestPlacement.width,
                height: bestPlacement.height,
                zIndex: count - i
            });

            // Add video content region to occupied list
            const videoRegion = getVideoContentRegion(
                bestPlacement.x, bestPlacement.y,
                bestPlacement.width, bestPlacement.height,
                ar
            );
            occupiedRegions.push(videoRegion);
        }

        // Scale layout to fill container
        const scaledCells = scaleLayoutToFit(container, cells);

        return buildSmartLayoutResult(container, scaledCells, count);
    }

    /**
     * Find the best position for a video, considering existing occupied regions
     */
    function findBestPosition(container, width, height, aspectRatio, occupiedRegions) {
        let bestPos = null;
        let bestScore = -Infinity;

        // Grid of candidate positions
        const stepX = container.width / 10;
        const stepY = container.height / 10;

        for (let x = 0; x <= container.width - width; x += stepX) {
            for (let y = 0; y <= container.height - height; y += stepY) {
                const score = evaluatePosition(
                    container, x, y, width, height, aspectRatio, occupiedRegions
                );

                if (score > bestScore) {
                    bestScore = score;
                    bestPos = { x, y, score };
                }
            }
        }

        // Also try strategic positions
        const strategicPositions = [
            { x: 0, y: 0 },
            { x: container.width - width, y: 0 },
            { x: 0, y: container.height - height },
            { x: container.width - width, y: container.height - height },
            { x: (container.width - width) / 2, y: 0 },
            { x: (container.width - width) / 2, y: container.height - height },
            { x: 0, y: (container.height - height) / 2 },
            { x: container.width - width, y: (container.height - height) / 2 },
            { x: (container.width - width) / 2, y: (container.height - height) / 2 }
        ];

        for (const pos of strategicPositions) {
            if (pos.x < 0 || pos.y < 0) continue;
            const score = evaluatePosition(
                container, pos.x, pos.y, width, height, aspectRatio, occupiedRegions
            );
            if (score > bestScore) {
                bestScore = score;
                bestPos = { x: pos.x, y: pos.y, score };
            }
        }

        return bestPos;
    }

    /**
     * Evaluate how good a position is for placing a video
     */
    function evaluatePosition(container, x, y, width, height, aspectRatio, occupiedRegions) {
        const videoRegion = getVideoContentRegion(x, y, width, height, aspectRatio);
        let score = 100;

        // Penalize overlap with existing video content regions
        for (const occupied of occupiedRegions) {
            const overlap = getRegionOverlap(videoRegion, occupied);
            const overlapArea = overlap.width * overlap.height;

            if (overlapArea > 0) {
                const videoArea = videoRegion.width * videoRegion.height;
                const overlapPercent = overlapArea / videoArea;
                score -= overlapPercent * 200;
            }
        }

        // Bonus for being fully on-screen
        if (x >= 0 && y >= 0 && x + width <= container.width && y + height <= container.height) {
            score += 25;
        }

        // Bonus for utilizing edges (more organized look)
        if (x < 10 || x + width > container.width - 10) score += 5;
        if (y < 10 || y + height > container.height - 10) score += 5;

        // Bonus for larger sizes
        const sizeBonus = (width * height) / (container.width * container.height) * 20;
        score += sizeBonus;

        return score;
    }

    /**
     * Get the video content region (actual video area, excluding letterbox)
     */
    function getVideoContentRegion(x, y, width, height, aspectRatio) {
        const cellAR = width / height;

        if (aspectRatio > cellAR) {
            // Video is wider - has top/bottom letterbox
            const videoHeight = width / aspectRatio;
            const letterboxHeight = (height - videoHeight) / 2;
            return {
                x: x,
                y: y + letterboxHeight,
                width: width,
                height: videoHeight
            };
        } else {
            // Video is taller - has left/right letterbox
            const videoWidth = height * aspectRatio;
            const letterboxWidth = (width - videoWidth) / 2;
            return {
                x: x + letterboxWidth,
                y: y,
                width: videoWidth,
                height: height
            };
        }
    }

    /**
     * Calculate overlap between two regions
     */
    function getRegionOverlap(r1, r2) {
        const x1 = Math.max(r1.x, r2.x);
        const y1 = Math.max(r1.y, r2.y);
        const x2 = Math.min(r1.x + r1.width, r2.x + r2.width);
        const y2 = Math.min(r1.y + r1.height, r2.y + r2.height);

        return {
            x: x1,
            y: y1,
            width: Math.max(0, x2 - x1),
            height: Math.max(0, y2 - y1)
        };
    }

    /**
     * Scale the layout to better fill the container
     * Ensures videos fill the available space properly
     */
    function scaleLayoutToFit(container, cells) {
        if (cells.length === 0) return cells;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const cell of cells) {
            minX = Math.min(minX, cell.x);
            minY = Math.min(minY, cell.y);
            maxX = Math.max(maxX, cell.x + cell.width);
            maxY = Math.max(maxY, cell.y + cell.height);
        }

        const currentWidth = maxX - minX;
        const currentHeight = maxY - minY;

        // Scale to fill container - allow full scaling, no arbitrary cap
        const scaleX = container.width / currentWidth;
        const scaleY = container.height / currentHeight;
        const scale = Math.min(scaleX, scaleY);

        const scaledWidth = currentWidth * scale;
        const scaledHeight = currentHeight * scale;
        const offsetX = (container.width - scaledWidth) / 2;
        const offsetY = (container.height - scaledHeight) / 2;

        return cells.map(cell => ({
            ...cell,
            x: (cell.x - minX) * scale + offsetX,
            y: (cell.y - minY) * scale + offsetY,
            width: cell.width * scale,
            height: cell.height * scale
        }));
    }

    /**
     * Horizontal stack layout - videos side by side, varying widths
     */
    function tryHorizontalStackLayout(container, streamData) {
        const cells = [];
        const count = streamData.length;

        const targetHeight = container.height * 0.95;
        let totalWidth = 0;

        streamData.forEach(data => {
            totalWidth += targetHeight * data.aspectRatio;
        });

        const scale = Math.min(container.width / totalWidth, 1.0);
        const scaledHeight = targetHeight * scale;

        let x = 0;
        for (const data of streamData) {
            const width = scaledHeight * data.aspectRatio;
            cells.push({
                streamId: data.stream.id,
                x,
                y: (container.height - scaledHeight) / 2,
                width,
                height: scaledHeight
            });
            x += width;
        }

        const totalUsedWidth = x;
        const offsetX = (container.width - totalUsedWidth) / 2;
        cells.forEach(cell => cell.x += offsetX);

        return buildSmartLayoutResult(container, cells, count);
    }

    /**
     * Vertical stack layout - videos stacked vertically
     */
    function tryVerticalStackLayout(container, streamData) {
        const cells = [];
        const count = streamData.length;

        const targetWidth = container.width * 0.95;
        let totalHeight = 0;

        streamData.forEach(data => {
            totalHeight += targetWidth / data.aspectRatio;
        });

        const scale = Math.min(container.height / totalHeight, 1.0);
        const scaledWidth = targetWidth * scale;

        let y = 0;
        for (const data of streamData) {
            const height = scaledWidth / data.aspectRatio;
            cells.push({
                streamId: data.stream.id,
                x: (container.width - scaledWidth) / 2,
                y,
                width: scaledWidth,
                height
            });
            y += height;
        }

        const totalUsedHeight = y;
        const offsetY = (container.height - totalUsedHeight) / 2;
        cells.forEach(cell => cell.y += offsetY);

        return buildSmartLayoutResult(container, cells, count);
    }

    /**
     * Mosaic layout - featured video with smaller tiles
     */
    function tryMosaicLayout(container, streamData) {
        const count = streamData.length;
        const cells = [];

        if (count <= 2) {
            return tryHorizontalStackLayout(container, streamData);
        }

        // Sort by aspect ratio
        const sorted = [...streamData].sort((a, b) => a.aspectRatio - b.aspectRatio);

        // Feature the widest video
        const featured = sorted[sorted.length - 1];
        const others = sorted.slice(0, -1);

        // Featured video gets 65% of width
        const featuredWidth = container.width * 0.65;
        const featuredHeight = Math.min(featuredWidth / featured.aspectRatio, container.height);
        const adjustedFeaturedWidth = featuredHeight * featured.aspectRatio;

        cells.push({
            streamId: featured.stream.id,
            x: 0,
            y: (container.height - featuredHeight) / 2,
            width: adjustedFeaturedWidth,
            height: featuredHeight,
            zIndex: 1
        });

        // Stack other videos on the right
        const sideWidth = container.width - adjustedFeaturedWidth;
        const sideHeight = container.height / others.length;

        others.forEach((data, i) => {
            const ar = data.aspectRatio;
            const videoHeight = Math.min(sideHeight * 0.95, sideWidth / ar);
            const videoWidth = videoHeight * ar;

            cells.push({
                streamId: data.stream.id,
                x: adjustedFeaturedWidth + (sideWidth - videoWidth) / 2,
                y: i * sideHeight + (sideHeight - videoHeight) / 2,
                width: videoWidth,
                height: videoHeight,
                zIndex: i + 2
            });
        });

        return buildSmartLayoutResult(container, cells, count);
    }

    /**
     * Diagonal layout - videos arranged diagonally with overlap
     */
    function tryDiagonalLayout(container, streamData) {
        const count = streamData.length;
        const cells = [];

        // Calculate size for each video - ensure reasonable minimum size
        // Each video should be at least 40% of container for 2 videos, scaling down more gradually
        const sizeMultiplier = Math.max(0.5, 0.85 - count * 0.07);
        const baseWidth = container.width * sizeMultiplier;

        // Minimum size enforcement
        const minWidth = container.width * (count <= 2 ? 0.4 : count <= 4 ? 0.3 : 0.25);
        const effectiveWidth = Math.max(baseWidth, minWidth);

        // Calculate diagonal spacing
        const diagStepX = (container.width - effectiveWidth) / Math.max(1, count - 1);
        const diagStepY = (container.height - effectiveWidth * 0.6) / Math.max(1, count - 1);

        streamData.forEach((data, i) => {
            const ar = data.aspectRatio;
            const width = effectiveWidth;
            const height = width / ar;

            cells.push({
                streamId: data.stream.id,
                x: i * diagStepX,
                y: i * diagStepY,
                width,
                height: Math.min(height, container.height * 0.85),
                zIndex: count - i // First video on top
            });
        });

        // Ensure nothing goes off screen
        const clampedCells = cells.map(cell => ({
            ...cell,
            x: Math.max(0, Math.min(container.width - cell.width, cell.x)),
            y: Math.max(0, Math.min(container.height - cell.height, cell.y))
        }));

        return buildSmartLayoutResult(container, clampedCells, count);
    }

    /**
     * Build final layout result for smart layouts
     * Includes minimum size validation to prevent tiny videos
     */
    function buildSmartLayoutResult(container, cells, count) {
        const containerArea = container.width * container.height;
        let videoArea = 0;

        // Minimum size: each video should be at least 15% of container in both dimensions
        // For small counts, be more generous
        const minWidthRatio = count <= 2 ? 0.3 : count <= 4 ? 0.2 : 0.15;
        const minHeightRatio = count <= 2 ? 0.3 : count <= 4 ? 0.2 : 0.15;
        const minWidth = container.width * minWidthRatio;
        const minHeight = container.height * minHeightRatio;

        let hasTinyVideo = false;
        let smallestRatio = 1;

        for (const cell of cells) {
            videoArea += cell.width * cell.height;

            // Check if this video is too small
            const widthRatio = cell.width / container.width;
            const heightRatio = cell.height / container.height;
            const sizeRatio = Math.min(widthRatio, heightRatio);
            smallestRatio = Math.min(smallestRatio, sizeRatio);

            if (cell.width < minWidth || cell.height < minHeight) {
                hasTinyVideo = true;
            }
        }

        // Estimate actual visible area (accounting for overlaps)
        const overlapFactor = count > 1 ? Math.max(0.7, 1 - count * 0.05) : 1;
        let visibleArea = Math.min(videoArea * overlapFactor, containerArea);

        // Heavily penalize layouts with tiny videos
        let efficiency = visibleArea / containerArea;
        if (hasTinyVideo) {
            // Reduce efficiency based on how small the smallest video is
            efficiency *= smallestRatio * 0.5;
        }

        return {
            cells,
            rows: Math.ceil(Math.sqrt(count)),
            cols: Math.ceil(count / Math.ceil(Math.sqrt(count))),
            efficiency,
            mode: 'smart'
        };
    }

    // Public API
    return {
        calculateLayout,
        calculateSmartLayout,
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
