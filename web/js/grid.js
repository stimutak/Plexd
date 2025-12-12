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

                // Apply z-index if specified (for coverflow layout overlapping)
                if (cell.zIndex !== undefined) {
                    videoWrapper.style.zIndex = cell.zIndex;
                } else {
                    videoWrapper.style.zIndex = '';
                }

                // Apply object-fit to the video element (for Tetris mode)
                const video = videoWrapper.querySelector('video');
                if (video) {
                    if (cell.objectFit === 'cover') {
                        video.style.objectFit = 'cover';
                        videoWrapper.classList.add('plexd-tetris-cell');
                    } else {
                        video.style.objectFit = 'contain';
                        videoWrapper.classList.remove('plexd-tetris-cell');
                    }
                }
            }
        });
    }

    // =========================================================================
    // Coverflow Layout - Z-depth overlapping window management
    // =========================================================================

    /**
     * Coverflow Layout - Creates a cascading, overlapping display by:
     * 1. Detecting letterboxing (black bars) on each video
     * 2. Allowing streams to overlap into each other's black bar zones
     * 3. Using z-depth for visual layering with hover-to-front effects
     * 4. Trying multiple layout strategies and picking the best
     *
     * @param {Object} container - {width, height} of the container
     * @param {Array} streams - Array of stream objects with aspect ratios
     * @returns {Object} Layout configuration with overlapping positions
     */
    function calculateCoverflowLayout(container, streams) {
        const count = streams.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, efficiency: 0, mode: 'coverflow' };

        // Single stream - just maximize it
        if (count === 1) {
            const layout = singleStreamLayout(container, streams[0]);
            layout.mode = 'coverflow';
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
            tryCoverflowOverlapLayout(container, streamData),
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
     * Coverflow overlap layout - the core algorithm
     * Places videos so they overlap into each other's letterbox zones with z-depth
     */
    function tryCoverflowOverlapLayout(container, streamData) {
        const count = streamData.length;
        const cells = [];

        // Calculate base sizes - give each video a reasonable share of container
        // Use larger allocation to ensure videos are substantial
        const totalArea = container.width * container.height;
        const areaPerStream = totalArea / Math.max(1, count * 0.7); // Allocate more area per stream

        // Sort by aspect ratio - place widest first, they set the horizontal structure
        // But preserve original index for z-index assignment
        const sorted = [...streamData].sort((a, b) => b.aspectRatio - a.aspectRatio);

        // Track occupied regions - both video content AND full cell bounds for visual separation
        const occupiedRegions = [];
        const occupiedCells = []; // Full cell bounds including letterbox

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
                    container, width, height, ar, occupiedRegions, occupiedCells
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

            const cellX = Math.max(0, Math.min(container.width - bestPlacement.width, bestPlacement.x));
            const cellY = Math.max(0, Math.min(container.height - bestPlacement.height, bestPlacement.y));

            cells.push({
                streamId: data.stream.id,
                x: cellX,
                y: cellY,
                width: bestPlacement.width,
                height: bestPlacement.height,
                // Use original stream index for z-index (higher index = placed later = on top)
                // Add base of 10 to ensure clear separation from other elements
                zIndex: 10 + count - data.index
            });

            // Add video content region to occupied list
            const videoRegion = getVideoContentRegion(
                cellX, cellY,
                bestPlacement.width, bestPlacement.height,
                ar
            );
            occupiedRegions.push(videoRegion);

            // Also track full cell bounds for visual separation
            occupiedCells.push({
                x: cellX,
                y: cellY,
                width: bestPlacement.width,
                height: bestPlacement.height
            });
        }

        // Scale layout to fill container
        const scaledCells = scaleLayoutToFit(container, cells);

        return buildCoverflowLayoutResult(container, scaledCells, count);
    }

    /**
     * Find the best position for a video, considering existing occupied regions
     * @param {Object} container - Container dimensions
     * @param {number} width - Video width
     * @param {number} height - Video height
     * @param {number} aspectRatio - Video aspect ratio
     * @param {Array} occupiedRegions - Video content regions (excluding letterbox)
     * @param {Array} occupiedCells - Full cell bounds (including letterbox)
     */
    function findBestPosition(container, width, height, aspectRatio, occupiedRegions, occupiedCells) {
        let bestPos = null;
        let bestScore = -Infinity;

        // Grid of candidate positions - use finer grid for better placement
        const stepX = container.width / 12;
        const stepY = container.height / 12;

        for (let x = 0; x <= container.width - width; x += stepX) {
            for (let y = 0; y <= container.height - height; y += stepY) {
                const score = evaluatePosition(
                    container, x, y, width, height, aspectRatio, occupiedRegions, occupiedCells
                );

                if (score > bestScore) {
                    bestScore = score;
                    bestPos = { x, y, score };
                }
            }
        }

        // Also try strategic positions (corners, edges, center)
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
                container, pos.x, pos.y, width, height, aspectRatio, occupiedRegions, occupiedCells
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
     * Now checks both video content regions AND full cell bounds for visual separation
     * @param {Object} container - Container dimensions
     * @param {number} x - X position
     * @param {number} y - Y position
     * @param {number} width - Video width
     * @param {number} height - Video height
     * @param {number} aspectRatio - Video aspect ratio
     * @param {Array} occupiedRegions - Video content regions
     * @param {Array} occupiedCells - Full cell bounds
     */
    function evaluatePosition(container, x, y, width, height, aspectRatio, occupiedRegions, occupiedCells) {
        const videoRegion = getVideoContentRegion(x, y, width, height, aspectRatio);
        const cellRegion = { x, y, width, height };
        let score = 100;

        // Maximum allowed overlap percentages - these are HARD LIMITS
        const MAX_CONTENT_OVERLAP = 0.15; // Only allow 15% overlap of actual video content
        const MAX_CELL_OVERLAP = 0.35;    // Allow 35% overlap of cells (letterbox areas can overlap)

        // Check content overlap (actual video, not letterbox)
        for (const occupied of occupiedRegions) {
            const overlap = getRegionOverlap(videoRegion, occupied);
            const overlapArea = overlap.width * overlap.height;

            if (overlapArea > 0) {
                const videoArea = videoRegion.width * videoRegion.height;
                const overlapPercent = overlapArea / videoArea;

                // Hard rejection for too much content overlap
                if (overlapPercent > MAX_CONTENT_OVERLAP) {
                    return -Infinity;
                }

                // Heavy penalty for any content overlap (exponential penalty)
                score -= overlapPercent * overlapPercent * 1000;
            }
        }

        // Check visual cell overlap (including letterbox areas)
        for (const occupied of occupiedCells) {
            const overlap = getRegionOverlap(cellRegion, occupied);
            const overlapArea = overlap.width * overlap.height;

            if (overlapArea > 0) {
                const cellArea = width * height;
                const overlapPercent = overlapArea / cellArea;

                // Hard rejection for too much visual overlap
                if (overlapPercent > MAX_CELL_OVERLAP) {
                    return -Infinity;
                }

                // Moderate penalty for visual overlap (letterbox overlap is okay-ish)
                score -= overlapPercent * 150;
            }
        }

        // Bonus for being fully on-screen
        if (x >= 0 && y >= 0 && x + width <= container.width && y + height <= container.height) {
            score += 30;
        }

        // Bonus for utilizing corners (more organized, less chaotic look)
        const atLeft = x < 20;
        const atRight = x + width > container.width - 20;
        const atTop = y < 20;
        const atBottom = y + height > container.height - 20;

        if ((atLeft || atRight) && (atTop || atBottom)) {
            score += 15; // Corner bonus
        } else if (atLeft || atRight || atTop || atBottom) {
            score += 8; // Edge bonus
        }

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
     * More conservative scaling to avoid introducing overlaps
     * Ensures videos fill the available space properly without excessive overlap
     */
    function scaleLayoutToFit(container, cells) {
        if (cells.length === 0) return cells;
        if (cells.length === 1) {
            // Single cell - just center it without scaling
            const cell = cells[0];
            return [{
                ...cell,
                x: (container.width - cell.width) / 2,
                y: (container.height - cell.height) / 2
            }];
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const cell of cells) {
            minX = Math.min(minX, cell.x);
            minY = Math.min(minY, cell.y);
            maxX = Math.max(maxX, cell.x + cell.width);
            maxY = Math.max(maxY, cell.y + cell.height);
        }

        const currentWidth = maxX - minX;
        const currentHeight = maxY - minY;

        // Calculate scale to fill container, but cap it to avoid excessive overlap
        const scaleX = container.width / currentWidth;
        const scaleY = container.height / currentHeight;

        // Use more conservative scaling - don't scale up too aggressively
        // This prevents small layouts from being blown up and causing overlap
        const rawScale = Math.min(scaleX, scaleY);
        const maxAllowedScale = 1.3; // Cap at 130% to prevent overlap issues
        const scale = Math.min(rawScale, maxAllowedScale);

        const scaledWidth = currentWidth * scale;
        const scaledHeight = currentHeight * scale;
        const offsetX = (container.width - scaledWidth) / 2;
        const offsetY = (container.height - scaledHeight) / 2;

        const scaledCells = cells.map(cell => ({
            ...cell,
            x: (cell.x - minX) * scale + offsetX,
            y: (cell.y - minY) * scale + offsetY,
            width: cell.width * scale,
            height: cell.height * scale
        }));

        // Verify no excessive overlaps were introduced by scaling
        // If so, fall back to unscaled layout centered in container
        const hasExcessiveOverlap = checkForExcessiveOverlap(scaledCells, 0.4);
        if (hasExcessiveOverlap) {
            // Fall back to just centering without scaling
            const unscaledOffsetX = (container.width - currentWidth) / 2 - minX;
            const unscaledOffsetY = (container.height - currentHeight) / 2 - minY;
            return cells.map(cell => ({
                ...cell,
                x: cell.x + unscaledOffsetX,
                y: cell.y + unscaledOffsetY
            }));
        }

        return scaledCells;
    }

    /**
     * Check if cells have excessive overlap
     * @param {Array} cells - Array of cell positions
     * @param {number} threshold - Maximum allowed overlap ratio (0-1)
     * @returns {boolean} True if excessive overlap exists
     */
    function checkForExcessiveOverlap(cells, threshold) {
        for (let i = 0; i < cells.length; i++) {
            for (let j = i + 1; j < cells.length; j++) {
                const overlap = getRegionOverlap(cells[i], cells[j]);
                const overlapArea = overlap.width * overlap.height;

                if (overlapArea > 0) {
                    const smallerArea = Math.min(
                        cells[i].width * cells[i].height,
                        cells[j].width * cells[j].height
                    );
                    const overlapRatio = overlapArea / smallerArea;

                    if (overlapRatio > threshold) {
                        return true;
                    }
                }
            }
        }
        return false;
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
                height: scaledHeight,
                // Consistent z-index based on stream index
                zIndex: 10 + data.index
            });
            x += width;
        }

        const totalUsedWidth = x;
        const offsetX = (container.width - totalUsedWidth) / 2;
        cells.forEach(cell => cell.x += offsetX);

        return buildCoverflowLayoutResult(container, cells, count);
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
                height,
                // Consistent z-index based on stream index
                zIndex: 10 + data.index
            });
            y += height;
        }

        const totalUsedHeight = y;
        const offsetY = (container.height - totalUsedHeight) / 2;
        cells.forEach(cell => cell.y += offsetY);

        return buildCoverflowLayoutResult(container, cells, count);
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
            // Featured video gets highest z-index (on top) with base offset
            zIndex: 10 + count
        });

        // Stack other videos on the right - no overlap in this layout
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
                // Use original stream index for consistent z-ordering
                zIndex: 10 + data.index
            });
        });

        return buildCoverflowLayoutResult(container, cells, count);
    }

    /**
     * Diagonal layout - videos arranged diagonally with controlled overlap
     * Reduces overlap compared to before by using smaller video sizes and better spacing
     */
    function tryDiagonalLayout(container, streamData) {
        const count = streamData.length;
        const cells = [];

        // Calculate size for each video - smaller sizes to reduce overlap
        // Reduce size more aggressively as video count increases
        const sizeMultiplier = Math.max(0.35, 0.7 - count * 0.1);
        const baseWidth = container.width * sizeMultiplier;

        // Minimum size enforcement - but not as aggressive for diagonal
        const minWidth = container.width * (count <= 2 ? 0.35 : count <= 4 ? 0.25 : 0.2);
        const effectiveWidth = Math.max(baseWidth, minWidth);

        // Calculate diagonal spacing - spread videos more to reduce overlap
        // Leave margin at edges
        const margin = effectiveWidth * 0.1;
        const availableWidth = container.width - effectiveWidth - margin * 2;
        const availableHeight = container.height - effectiveWidth * 0.6 - margin * 2;

        const diagStepX = availableWidth / Math.max(1, count - 1);
        const diagStepY = availableHeight / Math.max(1, count - 1);

        streamData.forEach((data, i) => {
            const ar = data.aspectRatio;
            const width = effectiveWidth;
            const height = Math.min(width / ar, container.height * 0.7);

            cells.push({
                streamId: data.stream.id,
                x: margin + i * diagStepX,
                y: margin + i * diagStepY,
                width,
                height,
                // Use original stream index for z-ordering, first stream on top
                // Add base offset for clear z-depth separation
                zIndex: 10 + count - data.index
            });
        });

        // Ensure nothing goes off screen
        const clampedCells = cells.map(cell => ({
            ...cell,
            x: Math.max(0, Math.min(container.width - cell.width, cell.x)),
            y: Math.max(0, Math.min(container.height - cell.height, cell.y))
        }));

        return buildCoverflowLayoutResult(container, clampedCells, count);
    }

    /**
     * Build final layout result for coverflow layouts
     * Includes minimum size validation to prevent tiny videos
     */
    function buildCoverflowLayoutResult(container, cells, count) {
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
            mode: 'coverflow'
        };
    }

    // =========================================================================
    // Tetris Layout - Intelligent bin-packing to eliminate black bars
    // =========================================================================

    /**
     * Tetris Layout - Maximizes visible video content by:
     * 1. Intelligently packing videos to fill the container
     * 2. Cropping/zooming into videos to eliminate letterboxing
     * 3. Using smart overlap where letterbox zones would be
     * 4. No z-depth layering - all videos at same level
     *
     * @param {Object} container - {width, height} of the container
     * @param {Array} streams - Array of stream objects with aspect ratios
     * @returns {Object} Layout configuration with tight-packed positions
     */
    function calculateTetrisLayout(container, streams) {
        const count = streams.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, efficiency: 0, mode: 'tetris' };

        // Single stream - maximize and crop to fill
        if (count === 1) {
            const stream = streams[0];
            const ar = stream.aspectRatio || 16/9;
            const containerAR = container.width / container.height;

            // Crop to fill (no black bars) using object-fit: cover logic
            let width, height;
            if (ar > containerAR) {
                // Video is wider - fit to height, crop sides
                height = container.height;
                width = height * ar;
            } else {
                // Video is taller - fit to width, crop top/bottom
                width = container.width;
                height = width / ar;
            }

            return {
                cells: [{
                    streamId: stream.id,
                    x: (container.width - width) / 2,
                    y: (container.height - height) / 2,
                    width,
                    height,
                    objectFit: 'cover' // Signal to use cover mode
                }],
                rows: 1,
                cols: 1,
                efficiency: 1.0,
                mode: 'tetris'
            };
        }

        // Analyze streams and try multiple intelligent packing strategies
        const streamData = streams.map((stream, index) => ({
            stream,
            index,
            aspectRatio: stream.aspectRatio || 16/9
        }));

        // Try multiple layout strategies optimized for Tetris-style packing
        const layouts = [
            tryTetrisBinPack(container, streamData),
            tryTetrisRowPack(container, streamData),
            tryTetrisColumnPack(container, streamData),
            tryTetrisSplitPack(container, streamData)
        ];

        // Pick the layout with highest efficiency (most screen coverage)
        let bestLayout = layouts[0];
        for (const layout of layouts) {
            if (layout && layout.efficiency > bestLayout.efficiency) {
                bestLayout = layout;
            }
        }

        return bestLayout;
    }

    /**
     * Tetris Bin-Pack - Uses a skyline algorithm to pack videos tightly
     * Videos are scaled and positioned to fill gaps like Tetris blocks
     */
    function tryTetrisBinPack(container, streamData) {
        const count = streamData.length;
        const cells = [];

        // Initialize skyline (tracks the "top" of placed items at each x position)
        const skyline = [{ x: 0, y: 0, width: container.width }];

        // Sort by aspect ratio to pack similar shapes together
        const sorted = [...streamData].sort((a, b) => b.aspectRatio - a.aspectRatio);

        // Calculate target size per video to fill container
        const targetAreaPerVideo = (container.width * container.height) / count;

        for (const data of sorted) {
            const ar = data.aspectRatio;

            // Calculate ideal dimensions based on target area
            let height = Math.sqrt(targetAreaPerVideo / ar);
            let width = height * ar;

            // Scale to reasonable size (30-60% of container dimension)
            const maxWidth = container.width * 0.65;
            const maxHeight = container.height * 0.65;
            const minWidth = container.width * 0.25;
            const minHeight = container.height * 0.25;

            if (width > maxWidth) {
                width = maxWidth;
                height = width / ar;
            }
            if (height > maxHeight) {
                height = maxHeight;
                width = height * ar;
            }
            if (width < minWidth) {
                width = minWidth;
                height = width / ar;
            }
            if (height < minHeight) {
                height = minHeight;
                width = height * ar;
            }

            // Find best position using skyline algorithm
            const pos = findTetrisPosition(skyline, width, height, container);

            if (pos) {
                cells.push({
                    streamId: data.stream.id,
                    x: pos.x,
                    y: pos.y,
                    width,
                    height,
                    objectFit: 'cover' // Use cover to eliminate black bars
                });

                // Update skyline
                updateTetrisSkyline(skyline, pos.x, pos.y + height, width, container);
            }
        }

        // Scale and center the layout to fill container
        return scaleTetrisLayout(container, cells, count);
    }

    /**
     * Find the best position for a Tetris block using skyline algorithm
     */
    function findTetrisPosition(skyline, width, height, container) {
        let bestPos = null;
        let bestWaste = Infinity;

        for (let i = 0; i < skyline.length; i++) {
            const seg = skyline[i];

            // Check if block fits starting at this segment
            if (seg.x + width <= container.width && seg.y + height <= container.height) {
                // Calculate "waste" - how much empty space this creates
                let maxY = seg.y;
                let spanWidth = 0;

                // Find the actual height needed (max of all spanned segments)
                for (let j = i; j < skyline.length && spanWidth < width; j++) {
                    const s = skyline[j];
                    if (s.x >= seg.x + width) break;
                    maxY = Math.max(maxY, s.y);
                    spanWidth = s.x + s.width - seg.x;
                }

                if (maxY + height <= container.height) {
                    // Waste = how much we have to go above the skyline
                    const waste = maxY - seg.y + (maxY * 0.1); // Prefer lower positions

                    if (waste < bestWaste) {
                        bestWaste = waste;
                        bestPos = { x: seg.x, y: maxY };
                    }
                }
            }
        }

        return bestPos;
    }

    /**
     * Update skyline after placing a Tetris block
     */
    function updateTetrisSkyline(skyline, x, newY, width, container) {
        const endX = x + width;
        const newSegments = [];

        for (const seg of skyline) {
            const segEnd = seg.x + seg.width;

            if (segEnd <= x || seg.x >= endX) {
                // No overlap - keep segment
                newSegments.push(seg);
            } else {
                // Overlap - split segment
                if (seg.x < x) {
                    newSegments.push({ x: seg.x, y: seg.y, width: x - seg.x });
                }
                if (segEnd > endX) {
                    newSegments.push({ x: endX, y: seg.y, width: segEnd - endX });
                }
            }
        }

        // Add new segment for placed block
        newSegments.push({ x, y: newY, width });

        // Sort and merge adjacent segments at same height
        newSegments.sort((a, b) => a.x - b.x);

        // Clear and refill skyline
        skyline.length = 0;
        for (const seg of newSegments) {
            const last = skyline[skyline.length - 1];
            if (last && Math.abs(last.x + last.width - seg.x) < 1 && Math.abs(last.y - seg.y) < 1) {
                last.width += seg.width;
            } else {
                skyline.push({ ...seg });
            }
        }
    }

    /**
     * Tetris Row Pack - Pack videos in rows with variable heights
     * Eliminates horizontal gaps by stretching to fill width
     */
    function tryTetrisRowPack(container, streamData) {
        const count = streamData.length;
        const cells = [];

        // Calculate optimal number of rows
        const numRows = Math.ceil(Math.sqrt(count * (container.height / container.width)));
        const videosPerRow = Math.ceil(count / numRows);

        let streamIndex = 0;
        let currentY = 0;
        const rowHeights = [];

        // First pass: calculate row heights
        for (let row = 0; row < numRows && streamIndex < count; row++) {
            const rowStreams = [];
            const rowEnd = Math.min(streamIndex + videosPerRow, count);

            for (let i = streamIndex; i < rowEnd; i++) {
                rowStreams.push(streamData[i]);
            }

            // Calculate row height to fill width exactly
            const totalAR = rowStreams.reduce((sum, d) => sum + d.aspectRatio, 0);
            const rowHeight = container.width / totalAR;
            rowHeights.push({ height: rowHeight, streams: rowStreams });

            streamIndex = rowEnd;
        }

        // Scale row heights to fit container
        const totalHeight = rowHeights.reduce((sum, r) => sum + r.height, 0);
        const scale = container.height / totalHeight;

        // Second pass: position cells
        currentY = 0;
        for (const row of rowHeights) {
            const scaledHeight = row.height * scale;
            let currentX = 0;

            for (const data of row.streams) {
                const width = scaledHeight * data.aspectRatio;

                cells.push({
                    streamId: data.stream.id,
                    x: currentX,
                    y: currentY,
                    width,
                    height: scaledHeight,
                    objectFit: 'cover'
                });

                currentX += width;
            }

            currentY += scaledHeight;
        }

        return buildTetrisLayoutResult(container, cells, count);
    }

    /**
     * Tetris Column Pack - Pack videos in columns with variable widths
     */
    function tryTetrisColumnPack(container, streamData) {
        const count = streamData.length;
        const cells = [];

        // Calculate optimal number of columns
        const numCols = Math.ceil(Math.sqrt(count * (container.width / container.height)));
        const videosPerCol = Math.ceil(count / numCols);

        let streamIndex = 0;
        const colWidths = [];

        // First pass: calculate column widths
        for (let col = 0; col < numCols && streamIndex < count; col++) {
            const colStreams = [];
            const colEnd = Math.min(streamIndex + videosPerCol, count);

            for (let i = streamIndex; i < colEnd; i++) {
                colStreams.push(streamData[i]);
            }

            // Calculate column width to fill height exactly
            const totalInvAR = colStreams.reduce((sum, d) => sum + 1/d.aspectRatio, 0);
            const colWidth = container.height / totalInvAR;
            colWidths.push({ width: colWidth, streams: colStreams });

            streamIndex = colEnd;
        }

        // Scale column widths to fit container
        const totalWidth = colWidths.reduce((sum, c) => sum + c.width, 0);
        const scale = container.width / totalWidth;

        // Second pass: position cells
        let currentX = 0;
        for (const col of colWidths) {
            const scaledWidth = col.width * scale;
            let currentY = 0;

            for (const data of col.streams) {
                const height = scaledWidth / data.aspectRatio;

                cells.push({
                    streamId: data.stream.id,
                    x: currentX,
                    y: currentY,
                    width: scaledWidth,
                    height,
                    objectFit: 'cover'
                });

                currentY += height;
            }

            currentX += scaledWidth;
        }

        return buildTetrisLayoutResult(container, cells, count);
    }

    /**
     * Tetris Split Pack - Recursively splits container for optimal packing
     * Similar to treemap algorithm
     */
    function tryTetrisSplitPack(container, streamData) {
        const count = streamData.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, efficiency: 0, mode: 'tetris' };

        const cells = [];

        // Assign weights based on aspect ratio (wider videos get more area)
        const totalWeight = streamData.reduce((sum, d) => sum + Math.sqrt(d.aspectRatio), 0);
        const dataWithWeights = streamData.map(d => ({
            ...d,
            weight: Math.sqrt(d.aspectRatio) / totalWeight
        }));

        // Recursive split function
        function splitLayout(rect, items) {
            if (items.length === 0) return;

            if (items.length === 1) {
                const data = items[0];
                cells.push({
                    streamId: data.stream.id,
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    objectFit: 'cover'
                });
                return;
            }

            // Determine split direction based on rect shape
            const splitHorizontal = rect.width > rect.height;

            // Find optimal split point (around 50% by weight)
            let splitWeight = 0;
            let splitIndex = 0;
            const targetWeight = items.reduce((sum, d) => sum + d.weight, 0) / 2;

            for (let i = 0; i < items.length; i++) {
                splitWeight += items[i].weight;
                if (splitWeight >= targetWeight) {
                    splitIndex = i + 1;
                    break;
                }
            }

            if (splitIndex === 0) splitIndex = 1;
            if (splitIndex >= items.length) splitIndex = items.length - 1;

            const firstItems = items.slice(0, splitIndex);
            const secondItems = items.slice(splitIndex);

            const firstWeight = firstItems.reduce((sum, d) => sum + d.weight, 0);
            const totalItemWeight = items.reduce((sum, d) => sum + d.weight, 0);
            const splitRatio = firstWeight / totalItemWeight;

            if (splitHorizontal) {
                const splitX = rect.x + rect.width * splitRatio;
                splitLayout({ x: rect.x, y: rect.y, width: splitX - rect.x, height: rect.height }, firstItems);
                splitLayout({ x: splitX, y: rect.y, width: rect.x + rect.width - splitX, height: rect.height }, secondItems);
            } else {
                const splitY = rect.y + rect.height * splitRatio;
                splitLayout({ x: rect.x, y: rect.y, width: rect.width, height: splitY - rect.y }, firstItems);
                splitLayout({ x: rect.x, y: splitY, width: rect.width, height: rect.y + rect.height - splitY }, secondItems);
            }
        }

        splitLayout({ x: 0, y: 0, width: container.width, height: container.height }, dataWithWeights);

        return buildTetrisLayoutResult(container, cells, count);
    }

    /**
     * Scale Tetris layout to fill container and center it
     */
    function scaleTetrisLayout(container, cells, count) {
        if (cells.length === 0) {
            return { cells: [], rows: 0, cols: 0, efficiency: 0, mode: 'tetris' };
        }

        // Find bounds
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const cell of cells) {
            minX = Math.min(minX, cell.x);
            minY = Math.min(minY, cell.y);
            maxX = Math.max(maxX, cell.x + cell.width);
            maxY = Math.max(maxY, cell.y + cell.height);
        }

        const currentWidth = maxX - minX;
        const currentHeight = maxY - minY;

        // Scale to fill container
        const scaleX = container.width / currentWidth;
        const scaleY = container.height / currentHeight;
        const scale = Math.min(scaleX, scaleY);

        const scaledWidth = currentWidth * scale;
        const scaledHeight = currentHeight * scale;

        // Center in container
        const offsetX = (container.width - scaledWidth) / 2;
        const offsetY = (container.height - scaledHeight) / 2;

        const scaledCells = cells.map(cell => ({
            ...cell,
            x: (cell.x - minX) * scale + offsetX,
            y: (cell.y - minY) * scale + offsetY,
            width: cell.width * scale,
            height: cell.height * scale
        }));

        return buildTetrisLayoutResult(container, scaledCells, count);
    }

    /**
     * Build final layout result for Tetris mode
     */
    function buildTetrisLayoutResult(container, cells, count) {
        const containerArea = container.width * container.height;
        let totalCellArea = 0;

        for (const cell of cells) {
            totalCellArea += cell.width * cell.height;
        }

        // Efficiency is how much of the container is covered
        // With object-fit: cover, cells fill their bounds completely
        const efficiency = Math.min(totalCellArea / containerArea, 1.0);

        // Estimate grid dimensions
        const avgWidth = cells.length > 0
            ? cells.reduce((sum, c) => sum + c.width, 0) / cells.length
            : container.width;
        const cols = Math.max(1, Math.round(container.width / avgWidth));

        return {
            cells,
            rows: Math.ceil(count / cols),
            cols,
            efficiency,
            mode: 'tetris'
        };
    }

    // Public API
    return {
        calculateLayout,
        calculateCoverflowLayout,
        calculateTetrisLayout,
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
