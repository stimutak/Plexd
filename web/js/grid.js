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
     * Build the actual layout with positions and sizes.
     * Last row gets wider cells when it has fewer streams than cols
     * (eliminates black gaps for odd counts like 3, 5, 7).
     */
    function buildGridLayout(container, streams, grid) {
        const { rows, cols } = grid;
        const cellHeight = container.height / rows;
        const cells = [];

        let streamIndex = 0;
        for (let row = 0; row < rows && streamIndex < streams.length; row++) {
            // How many streams go in this row?
            const remainingStreams = streams.length - streamIndex;
            const streamsInRow = (row === rows - 1) ? remainingStreams : Math.min(cols, remainingStreams);
            const rowCellWidth = container.width / streamsInRow;

            for (let col = 0; col < streamsInRow; col++) {
                const stream = streams[streamIndex];
                const aspectRatio = stream.aspectRatio || 16/9;

                // Fit video within cell while maintaining aspect ratio
                const fit = fitToContainer(
                    { width: rowCellWidth, height: cellHeight },
                    aspectRatio
                );

                cells.push({
                    streamId: stream.id,
                    x: col * rowCellWidth + (rowCellWidth - fit.width) / 2,
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
            cellWidth: container.width / cols,
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

                // Apply transform if specified (for coverflow carousel effect or collage rotation)
                if (cell.collageRotation !== undefined) {
                    videoWrapper.style.transform = `rotate(${cell.collageRotation}deg)`;
                    videoWrapper.style.transformOrigin = 'center center';
                } else if (cell.transform && cell.transform !== 'none') {
                    videoWrapper.style.transform = cell.transform;
                    videoWrapper.style.transformOrigin = 'center center';
                } else {
                    videoWrapper.style.transform = '';
                    videoWrapper.style.transformOrigin = '';
                }

                // Apply opacity if specified (for coverflow fade effect)
                if (cell.opacity !== undefined && cell.opacity < 1) {
                    videoWrapper.style.opacity = cell.opacity;
                } else {
                    videoWrapper.style.opacity = '';
                }

                // Handle coverflow selected state
                if (cell.isSelected !== undefined) {
                    videoWrapper.classList.toggle('plexd-coverflow-selected', cell.isSelected);
                    videoWrapper.classList.toggle('plexd-coverflow-side', !cell.isSelected && !cell.hidden);
                } else {
                    videoWrapper.classList.remove('plexd-coverflow-selected', 'plexd-coverflow-side');
                }

                // Handle hidden state (for off-screen coverflow items)
                if (cell.hidden) {
                    videoWrapper.style.visibility = 'hidden';
                    videoWrapper.style.pointerEvents = 'none';
                } else {
                    videoWrapper.style.visibility = '';
                    videoWrapper.style.pointerEvents = '';
                }

                // Apply object-fit to the video element (for Tetris/Wall modes)
                const video = videoWrapper.querySelector('video');
                if (video) {
                    if (cell.objectFit === 'cover') {
                        video.style.objectFit = 'cover';
                        videoWrapper.classList.add('plexd-tetris-cell');
                        // Apply stored pan position for this stream
                        if (typeof PlexdStream !== 'undefined' && PlexdStream.getPanPosition) {
                            const pan = PlexdStream.getPanPosition(cell.streamId);
                            video.style.objectPosition = `${pan.x}% ${pan.y}%`;
                        }
                    } else {
                        video.style.objectFit = 'contain';
                        video.style.objectPosition = ''; // Reset when not in cover mode
                        videoWrapper.classList.remove('plexd-tetris-cell');
                    }

                    // Wall: Crop Tiles zoom — scale video inside overflow:hidden wrapper
                    if (cell.wallCropZoom) {
                        video.style.transform = `scale(${cell.wallCropZoom})`;
                        video.style.transformOrigin = typeof PlexdStream !== 'undefined' && PlexdStream.getPanPosition
                            ? (() => { const p = PlexdStream.getPanPosition(cell.streamId); return `${p.x}% ${p.y}%`; })()
                            : 'center center';
                        videoWrapper.classList.add('plexd-wall-crop');
                    } else {
                        video.style.transform = '';
                        video.style.transformOrigin = '';
                        videoWrapper.classList.remove('plexd-wall-crop');
                    }
                }

                // Spotlight hero marker
                if (cell.isSpotlightHero) {
                    videoWrapper.classList.add('plexd-spotlight-hero');
                } else {
                    videoWrapper.classList.remove('plexd-spotlight-hero');
                }

                // Crop Tiles selected highlight
                if (cell.isWallCropSelected) {
                    videoWrapper.classList.add('plexd-wall-crop-selected');
                } else {
                    videoWrapper.classList.remove('plexd-wall-crop-selected');
                }
            }
        });

        // Update navigation order cache in PlexdStream for consistent arrow key navigation
        if (typeof PlexdStream !== 'undefined' && PlexdStream.updateLayoutOrder) {
            PlexdStream.updateLayoutOrder(layout.cells);
        }
    }

    // =========================================================================
    // Coverflow Layout - Stream Selector Carousel Mode
    // =========================================================================

    // Track the currently selected index in coverflow mode
    let coverflowSelectedIndex = 0;

    /**
     * Coverflow Layout - Stream Selector Carousel
     *
     * PURPOSE: Select one stream from many while maintaining visual context of others.
     * Perfect for browsing through multiple streams and choosing which one to focus on.
     *
     * Features:
     * 1. Selected stream displayed prominently in the center at large size
     * 2. Adjacent streams visible on sides with 3D perspective effect
     * 3. Streams further away appear smaller, rotated, and faded
     * 4. Arrow keys cycle through selection
     * 5. Enter/Z enters focused view on selected stream
     *
     * @param {Object} container - {width, height} of the container
     * @param {Array} streams - Array of stream objects with aspect ratios
     * @param {number} selectedIdx - Index of the selected/focused stream (optional)
     * @returns {Object} Layout configuration with carousel positions
     */
    function calculateCoverflowLayout(container, streams, selectedIdx) {
        const count = streams.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, efficiency: 0, mode: 'coverflow', selectedIndex: 0 };

        // Use provided index or tracked index, clamped to valid range
        if (selectedIdx !== undefined) {
            coverflowSelectedIndex = Math.max(0, Math.min(count - 1, selectedIdx));
        } else {
            coverflowSelectedIndex = Math.max(0, Math.min(count - 1, coverflowSelectedIndex));
        }

        // Single stream - just maximize it
        if (count === 1) {
            const layout = singleStreamLayout(container, streams[0]);
            layout.mode = 'coverflow';
            layout.selectedIndex = 0;
            return layout;
        }

        // Build carousel layout
        return buildCarouselLayout(container, streams, coverflowSelectedIndex);
    }

    /**
     * Build the carousel/coverflow layout with center-focused stream
     */
    function buildCarouselLayout(container, streams, selectedIndex) {
        const count = streams.length;
        const cells = [];

        // Layout parameters
        const centerWidth = container.width * 0.55;  // Selected stream takes 55% width
        const centerHeight = container.height * 0.85; // 85% height
        const sideWidth = container.width * 0.25;    // Side streams are 25% width
        const sideHeight = container.height * 0.5;   // 50% height

        // Maximum visible streams on each side (beyond this they're off-screen)
        const maxVisibleSide = 3;

        // Center position
        const centerX = (container.width - centerWidth) / 2;
        const centerY = (container.height - centerHeight) / 2;

        // Calculate positions for each stream
        for (let i = 0; i < count; i++) {
            const stream = streams[i];
            const ar = stream.aspectRatio || 16/9;
            const relativePos = i - selectedIndex; // Position relative to selected (-2, -1, 0, 1, 2, etc.)

            let cell;

            if (relativePos === 0) {
                // Selected stream - center, large, no transform
                const fit = fitToContainer({ width: centerWidth, height: centerHeight }, ar);
                cell = {
                    streamId: stream.id,
                    x: centerX + (centerWidth - fit.width) / 2,
                    y: centerY + (centerHeight - fit.height) / 2,
                    width: fit.width,
                    height: fit.height,
                    zIndex: 100,
                    transform: 'none',
                    opacity: 1,
                    isSelected: true
                };
            } else {
                // Side streams - smaller, with perspective
                const absPos = Math.abs(relativePos);
                const direction = relativePos > 0 ? 1 : -1; // 1 = right, -1 = left

                // Streams too far away are hidden
                if (absPos > maxVisibleSide) {
                    cell = {
                        streamId: stream.id,
                        x: direction > 0 ? container.width + 100 : -sideWidth - 100,
                        y: container.height / 2 - sideHeight / 2,
                        width: sideWidth,
                        height: sideHeight,
                        zIndex: 1,
                        transform: 'none',
                        opacity: 0,
                        isSelected: false,
                        hidden: true
                    };
                } else {
                    // Calculate progressive scaling and positioning
                    const scale = Math.max(0.4, 1 - absPos * 0.2); // Scale down by 20% per position
                    const scaledWidth = sideWidth * scale;
                    const scaledHeight = sideHeight * scale;

                    // Fit video to the scaled cell
                    const fit = fitToContainer({ width: scaledWidth, height: scaledHeight }, ar);

                    // X position: spread out from center
                    let xOffset;
                    if (direction > 0) {
                        // Right side
                        xOffset = centerX + centerWidth + 20 + (absPos - 1) * (scaledWidth * 0.7);
                    } else {
                        // Left side
                        xOffset = centerX - scaledWidth - 20 - (absPos - 1) * (scaledWidth * 0.7);
                    }

                    // Y position: center vertically with slight offset for depth
                    const yOffset = (container.height - fit.height) / 2 + absPos * 10;

                    // Rotation angle for 3D effect
                    const rotateY = direction * (15 + absPos * 5); // Rotate towards center

                    // Opacity fades with distance
                    const opacity = Math.max(0.3, 1 - absPos * 0.25);

                    // Z-index decreases with distance from center
                    const zIndex = 50 - absPos * 10;

                    cell = {
                        streamId: stream.id,
                        x: xOffset,
                        y: yOffset,
                        width: fit.width,
                        height: fit.height,
                        zIndex: zIndex,
                        transform: `perspective(1000px) rotateY(${rotateY}deg) scale(${scale})`,
                        opacity: opacity,
                        isSelected: false,
                        relativePosition: relativePos
                    };
                }
            }

            cells.push(cell);
        }

        // Calculate efficiency (visible video area / container area)
        const containerArea = container.width * container.height;
        let visibleArea = 0;
        cells.forEach(cell => {
            if (!cell.hidden) {
                visibleArea += cell.width * cell.height * (cell.opacity || 1);
            }
        });

        return {
            cells,
            rows: 1,
            cols: count,
            efficiency: Math.min(visibleArea / containerArea, 1),
            mode: 'coverflow',
            selectedIndex: selectedIndex
        };
    }

    /**
     * Navigate coverflow selection (called from app.js)
     * @param {string} direction - 'next' or 'prev'
     * @param {number} count - Total number of streams
     * @returns {number} New selected index
     */
    function coverflowNavigate(direction, count) {
        if (direction === 'next') {
            coverflowSelectedIndex = (coverflowSelectedIndex + 1) % count;
        } else if (direction === 'prev') {
            coverflowSelectedIndex = (coverflowSelectedIndex - 1 + count) % count;
        }
        return coverflowSelectedIndex;
    }

    /**
     * Get current coverflow selected index
     */
    function getCoverflowSelectedIndex() {
        return coverflowSelectedIndex;
    }

    /**
     * Set coverflow selected index
     */
    function setCoverflowSelectedIndex(index) {
        coverflowSelectedIndex = index;
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
     * 2. Mode 1-3: Cropping/zooming into videos to eliminate letterboxing (object-fit: cover)
     * 3. Mode 4: Content Visible - shows ALL video content, overlaps only black bars
     * 4. No z-depth layering - all videos at same level
     *
     * Modes:
     * 0 = auto-best (picks from modes 1-3)
     * 1 = rows - videos in horizontal rows with cover
     * 2 = columns - videos in vertical columns with cover
     * 3 = treemap - recursive splitting with cover
     * 4 = content visible - show ALL content, smart overlap of black bars only
     *
     * @param {Object} container - {width, height} of the container
     * @param {Array} streams - Array of stream objects with aspect ratios
     * @param {number} mode - Layout mode: 1=rows, 2=columns, 3=treemap, 4=content-visible (0 = auto)
     * @returns {Object} Layout configuration with tight-packed positions
     */
    function calculateTetrisLayout(container, streams, mode = 0) {
        const count = streams.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, efficiency: 0, mode: 'tetris' };

        // Single stream - maximize and crop to fill (or contain for mode 4)
        if (count === 1) {
            const stream = streams[0];
            const ar = stream.aspectRatio || 16/9;
            const containerAR = container.width / container.height;

            if (mode === 4) {
                // Content Visible mode - use contain (no cropping)
                const fit = fitToContainer(container, ar);
                return {
                    cells: [{
                        streamId: stream.id,
                        x: (container.width - fit.width) / 2,
                        y: (container.height - fit.height) / 2,
                        width: fit.width,
                        height: fit.height,
                        objectFit: 'contain'
                    }],
                    rows: 1,
                    cols: 1,
                    efficiency: (fit.width * fit.height) / (container.width * container.height),
                    mode: 'tetris',
                    subMode: 'content-visible'
                };
            }

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

        // Analyze streams
        const streamData = streams.map((stream, index) => ({
            stream,
            index,
            aspectRatio: stream.aspectRatio || 16/9
        }));

        // If a specific mode is requested, use only that algorithm
        if (mode === 1) {
            // Mode 1: Row-based packing (videos in horizontal rows)
            return tryTetrisRowPack(container, streamData);
        } else if (mode === 2) {
            // Mode 2: Column-based packing (videos in vertical columns)
            return tryTetrisColumnPack(container, streamData);
        } else if (mode === 3) {
            // Mode 3: Treemap-style recursive splitting (pass lineup weights if set)
            return tryTetrisSplitPack(container, streamData, window._plexdLineupWeights);
        } else if (mode === 4) {
            // Mode 4: Content Visible - show ALL content, smart overlap
            return tryTetrisContentVisible(container, streamData);
        }

        // Auto mode (mode 0): Try all strategies and pick the best
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
        // Cap scale to 1.0 to prevent rows from exceeding container width
        const totalHeight = rowHeights.reduce((sum, r) => sum + r.height, 0);
        const scale = Math.min(1.0, container.height / totalHeight);

        // Calculate total layout dimensions after scaling
        const scaledTotalHeight = totalHeight * scale;
        const scaledTotalWidth = container.width * scale; // Row width scales with height

        // Center the layout in the container
        const offsetX = (container.width - scaledTotalWidth) / 2;
        const offsetY = (container.height - scaledTotalHeight) / 2;

        // Second pass: position cells
        currentY = offsetY;
        for (const row of rowHeights) {
            const scaledHeight = row.height * scale;
            let currentX = offsetX;

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
        // Cap scale to 1.0 to prevent columns from exceeding container height
        const totalWidth = colWidths.reduce((sum, c) => sum + c.width, 0);
        const scale = Math.min(1.0, container.width / totalWidth);

        // Calculate total layout dimensions after scaling
        const scaledTotalWidth = totalWidth * scale;
        const scaledTotalHeight = container.height * scale; // Column height scales with width

        // Center the layout in the container
        const offsetX = (container.width - scaledTotalWidth) / 2;
        const offsetY = (container.height - scaledTotalHeight) / 2;

        // Second pass: position cells
        let currentX = offsetX;
        for (const col of colWidths) {
            const scaledWidth = col.width * scale;
            let currentY = offsetY;

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
    function tryTetrisSplitPack(container, streamData, weights) {
        const count = streamData.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, efficiency: 0, mode: 'tetris' };

        const cells = [];

        // Assign weights: use external weights if provided, otherwise aspect-ratio-based
        const dataWithWeights = streamData.map(d => {
            const externalWeight = weights ? (weights.get(d.stream.id) || 1) : Math.sqrt(d.aspectRatio);
            return {
                ...d,
                weight: externalWeight
            };
        });
        const totalWeight = dataWithWeights.reduce((sum, d) => sum + d.weight, 0);
        dataWithWeights.forEach(d => { d.weight = d.weight / totalWeight; });

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
     * Tetris Content Visible Mode - Show ALL video content without cropping
     *
     * PURPOSE: Display all streams with maximum visible content where:
     * - NO video content is cropped
     * - Black bars (letterboxing) can overlap/hide behind other videos
     * - Videos are scaled and positioned to maximize screen usage
     * - Intelligently stacks videos so content areas don't overlap
     *
     * Perfect for when you want to see everything happening in all streams simultaneously.
     */
    function tryTetrisContentVisible(container, streamData) {
        const count = streamData.length;
        const cells = [];
        const containerAR = container.width / container.height;

        // Calculate optimal grid to fit all videos
        // We want to maximize the size of each video while fitting them all
        const cols = Math.ceil(Math.sqrt(count * containerAR / 1.78)); // Bias towards 16:9
        const rows = Math.ceil(count / cols);

        // Calculate base cell size
        const baseCellWidth = container.width / cols;
        const baseCellHeight = container.height / rows;

        // For Content Visible mode, we position videos with intelligent overlap
        // Videos are placed so their actual content doesn't overlap, but letterbox areas can

        // Sort by aspect ratio to group similar shapes
        const sorted = [...streamData].sort((a, b) => a.aspectRatio - b.aspectRatio);

        // Track actual video content regions for overlap detection
        const contentRegions = [];

        // First pass: calculate ideal positions in a grid
        for (let i = 0; i < sorted.length; i++) {
            const data = sorted[i];
            const ar = data.aspectRatio;

            // Calculate row and column
            const row = Math.floor(i / cols);
            const col = i % cols;

            // Allow videos to be larger than their grid cell to fill more space
            // Scale factor based on how many neighbors
            const hasLeft = col > 0;
            const hasRight = col < cols - 1 && i + 1 < count;
            const hasTop = row > 0;
            const hasBottom = row < rows - 1 && i + cols < count;

            // Expand size to utilize neighboring letterbox space
            let expandFactor = 1.15;
            if (count <= 2) expandFactor = 1.3;
            else if (count <= 4) expandFactor = 1.2;

            const cellWidth = baseCellWidth * expandFactor;
            const cellHeight = baseCellHeight * expandFactor;

            // Fit video to cell while maintaining aspect ratio
            const fit = fitToContainer({ width: cellWidth, height: cellHeight }, ar);

            // Position: start at grid cell center, then adjust
            const centerX = (col + 0.5) * baseCellWidth;
            const centerY = (row + 0.5) * baseCellHeight;

            let x = centerX - fit.width / 2;
            let y = centerY - fit.height / 2;

            // Clamp to container bounds
            x = Math.max(0, Math.min(container.width - fit.width, x));
            y = Math.max(0, Math.min(container.height - fit.height, y));

            // Calculate actual video content region (excluding letterbox)
            const videoContent = getVideoContentRegion(x, y, fit.width, fit.height, ar);

            // Check for content overlap with already placed videos
            let needsAdjustment = false;
            for (const existing of contentRegions) {
                const overlap = getRegionOverlap(videoContent, existing);
                if (overlap.width > 5 && overlap.height > 5) {
                    needsAdjustment = true;
                    // Shift away from overlap
                    if (videoContent.x < existing.x) {
                        x -= overlap.width * 0.5;
                    } else {
                        x += overlap.width * 0.5;
                    }
                    if (videoContent.y < existing.y) {
                        y -= overlap.height * 0.5;
                    } else {
                        y += overlap.height * 0.5;
                    }
                }
            }

            // Re-clamp after adjustment
            x = Math.max(0, Math.min(container.width - fit.width, x));
            y = Math.max(0, Math.min(container.height - fit.height, y));

            // Store the cell
            cells.push({
                streamId: data.stream.id,
                x: x,
                y: y,
                width: fit.width,
                height: fit.height,
                objectFit: 'contain', // No cropping
                zIndex: 10 + count - i // Later items on top
            });

            // Track content region
            contentRegions.push(getVideoContentRegion(x, y, fit.width, fit.height, ar));
        }

        // Calculate efficiency based on actual video content coverage
        const containerArea = container.width * container.height;
        let contentArea = 0;
        for (const cell of cells) {
            const data = sorted.find(d => d.stream.id === cell.streamId);
            if (data) {
                const videoContent = getVideoContentRegion(cell.x, cell.y, cell.width, cell.height, data.aspectRatio);
                contentArea += videoContent.width * videoContent.height;
            }
        }

        // Account for overlaps in letterbox areas
        const overlapFactor = count > 1 ? 0.85 : 1;
        const efficiency = Math.min((contentArea * overlapFactor) / containerArea, 1);

        return {
            cells,
            rows,
            cols,
            efficiency,
            mode: 'tetris',
            subMode: 'content-visible'
        };
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

    // =========================================================================
    // Wall Mode Layouts — Strips and Spotlight
    // =========================================================================

    /**
     * Strips layout — equal-width vertical columns, full container height.
     * Each stream fills a narrow column with object-fit: cover for center crop.
     */
    function calculateStripsLayout(container, streams) {
        const count = streams.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, mode: 'strips' };

        // Edge-to-edge: no gaps between strips for seamless wall effect
        const colWidth = container.width / count;

        const cells = streams.map((stream, i) => ({
            streamId: stream.id,
            x: i * colWidth,
            y: 0,
            width: colWidth,
            height: container.height,
            objectFit: 'cover'
        }));

        return { cells, rows: 1, cols: count, mode: 'strips' };
    }

    /**
     * Spotlight layout — hero stream at ~65% of screen, rest as thumbnails.
     * First stream in array is the hero. Thumbnails fill right side and bottom.
     */
    function calculateSpotlightLayout(container, streams) {
        const count = streams.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, mode: 'spotlight' };

        if (count === 1) {
            return {
                cells: [{
                    streamId: streams[0].id,
                    x: 0, y: 0,
                    width: container.width,
                    height: container.height,
                    objectFit: 'cover',
                    isSpotlightHero: true
                }],
                rows: 1, cols: 1, mode: 'spotlight'
            };
        }

        const gap = 3;
        const thumbCount = count - 1;

        // Hero takes left ~65%, full height
        // Thumbnails fill a column on the right, plus overflow to bottom row
        const heroRatio = thumbCount <= 4 ? 0.70 : thumbCount <= 8 ? 0.65 : 0.60;
        const heroWidth = Math.floor(container.width * heroRatio) - gap;
        const sideWidth = container.width - heroWidth - gap;

        // How many thumbs fit on the right column vs bottom row?
        // Right column: stack vertically along the hero's height
        const maxSideThumbs = Math.min(thumbCount, Math.max(2, Math.floor(container.height / 120)));
        const sideThumbs = Math.min(thumbCount, maxSideThumbs);
        const bottomThumbs = thumbCount - sideThumbs;

        const cells = [];

        // Hero cell
        const heroHeight = bottomThumbs > 0
            ? Math.floor(container.height * 0.78) - gap
            : container.height;
        cells.push({
            streamId: streams[0].id,
            x: 0, y: 0,
            width: heroWidth,
            height: heroHeight,
            objectFit: 'cover',
            isSpotlightHero: true
        });

        // Right-side thumbnails
        const sideThumbHeight = (heroHeight - gap * (sideThumbs - 1)) / sideThumbs;
        for (let i = 0; i < sideThumbs; i++) {
            cells.push({
                streamId: streams[1 + i].id,
                x: heroWidth + gap,
                y: i * (sideThumbHeight + gap),
                width: sideWidth,
                height: sideThumbHeight,
                objectFit: 'cover'
            });
        }

        // Bottom-row thumbnails (if any overflow)
        if (bottomThumbs > 0) {
            const bottomY = heroHeight + gap;
            const bottomHeight = container.height - bottomY;
            // Bottom row spans full width
            const bottomThumbWidth = (container.width - gap * (bottomThumbs - 1)) / bottomThumbs;
            for (let i = 0; i < bottomThumbs; i++) {
                cells.push({
                    streamId: streams[1 + sideThumbs + i].id,
                    x: i * (bottomThumbWidth + gap),
                    y: bottomY,
                    width: bottomThumbWidth,
                    height: bottomHeight,
                    objectFit: 'cover'
                });
            }
        }

        return { cells, rows: bottomThumbs > 0 ? 2 : 1, cols: count, mode: 'spotlight' };
    }

    // =========================================================================
    // Unified Density Layout Engine
    // =========================================================================
    // Dispatches to level-specific layout functions based on density (-1 to 5)
    // and variant (0+). Each level has a distinct visual density, from fullscreen
    // (single stream) through mosaic (maximum streams visible).

    /**
     * Unified entry point for the density layout system.
     * @param {number} density - Density level: -1=Fullscreen, 0=Focused, 1=Spotlight, 2=Grid, 3=Fill, 4=Strips, 5=Mosaic
     * @param {number} variant - Style variant within the density level (0-based)
     * @param {Object} container - {width, height} of the layout container
     * @param {Array} streams - Array of stream objects
     * @param {number} selectedIdx - Index of the selected/hero stream (-1 if none)
     * @returns {Object} Layout: { cells: [...], rows, cols, mode, ... }
     */
    function calculateDensityLayout(density, variant, container, streams, selectedIdx) {
        if (streams.length === 0) return { cells: [], rows: 0, cols: 0, mode: 'empty' };
        switch (density) {
            case -1: return densityFullscreen(container, streams, selectedIdx);
            case  0: return densityFocused(container, streams, selectedIdx);
            case  1: return densitySpotlight(variant, container, streams, selectedIdx);
            case  2: return densityGrid(variant, container, streams, selectedIdx);
            case  3: return densityFill(variant, container, streams, selectedIdx);
            case  4: return densityStrips(variant, container, streams, selectedIdx);
            case  5: return densityMosaic(variant, container, streams, selectedIdx);
            default: return densityGrid(0, container, streams, selectedIdx);
        }
    }

    /**
     * Density -1: Fullscreen — selected stream fills container, others hidden.
     */
    function densityFullscreen(container, streams, selectedIdx) {
        var idx = (selectedIdx >= 0 && selectedIdx < streams.length) ? selectedIdx : 0;
        var cells = streams.map(function(s, i) {
            if (i === idx) {
                return {
                    streamId: s.id,
                    x: 0,
                    y: 0,
                    width: container.width,
                    height: container.height,
                    objectFit: 'contain',
                    zIndex: 10
                };
            }
            return {
                streamId: s.id,
                x: 0,
                y: 0,
                width: 0,
                height: 0,
                hidden: true
            };
        });
        return { cells: cells, rows: 1, cols: 1, mode: 'density-fullscreen', selectedIndex: idx };
    }

    /**
     * Density 0: Focused — same positioning as fullscreen but mode signals
     * app.js to use browser-level focus (not true fullscreen API).
     */
    function densityFocused(container, streams, selectedIdx) {
        var layout = densityFullscreen(container, streams, selectedIdx);
        layout.mode = 'density-focused';
        return layout;
    }

    /**
     * Density 1: Spotlight — hero stream prominent, others as thumbnails.
     * Variant 0: Hero + side column (reuses existing spotlight algorithm)
     * Variant 1: Hero + bottom row
     */
    function densitySpotlight(variant, container, streams, selectedIdx) {
        var idx = (selectedIdx >= 0 && selectedIdx < streams.length) ? selectedIdx : 0;

        // Move selected stream to front for hero treatment
        var reordered = [streams[idx]];
        for (var i = 0; i < streams.length; i++) {
            if (i !== idx) reordered.push(streams[i]);
        }

        if (variant === 1) {
            return densitySpotlightBottom(container, reordered);
        }
        // Variant 0: delegate to existing spotlight with reordered streams
        var layout = calculateSpotlightLayout(container, reordered);
        layout.mode = 'density-spotlight';
        layout.selectedIndex = idx;
        return layout;
    }

    /**
     * Spotlight variant 1: Hero on top (~70% height), thumbs in bottom row.
     */
    function densitySpotlightBottom(container, streams) {
        var count = streams.length;
        if (count === 1) {
            return {
                cells: [{
                    streamId: streams[0].id,
                    x: 0, y: 0,
                    width: container.width,
                    height: container.height,
                    objectFit: 'cover',
                    isSpotlightHero: true
                }],
                rows: 1, cols: 1, mode: 'density-spotlight'
            };
        }

        var gap = 3;
        var heroRatio = 0.70;
        var heroHeight = Math.floor(container.height * heroRatio) - gap;
        var thumbCount = count - 1;
        var bottomHeight = container.height - heroHeight - gap;
        var thumbWidth = (container.width - gap * (thumbCount - 1)) / thumbCount;

        var cells = [];

        // Hero — full width, top 70%
        cells.push({
            streamId: streams[0].id,
            x: 0, y: 0,
            width: container.width,
            height: heroHeight,
            objectFit: 'cover',
            isSpotlightHero: true
        });

        // Bottom row thumbnails
        for (var i = 0; i < thumbCount; i++) {
            cells.push({
                streamId: streams[1 + i].id,
                x: i * (thumbWidth + gap),
                y: heroHeight + gap,
                width: thumbWidth,
                height: bottomHeight,
                objectFit: 'cover'
            });
        }

        return { cells: cells, rows: 2, cols: thumbCount, mode: 'density-spotlight' };
    }

    /**
     * Density 2: Grid — standard grid layouts.
     * Variant 0: Standard even grid (reuses calculateLayout)
     * Variant 1: Z-depth overlap — selected 65% centered, others fanned behind
     * Variant 2: Content-visible — standard grid, cells marked contentVisible
     */
    function densityGrid(variant, container, streams, selectedIdx) {
        if (variant === 1) {
            return densityGridZDepth(container, streams, selectedIdx);
        }
        if (variant === 2) {
            return densityGridContentVisible(container, streams);
        }
        // Variant 0: standard even grid
        var layout = calculateLayout(container, streams);
        layout.mode = 'density-grid';
        return layout;
    }

    /**
     * Grid variant 1: Z-depth overlap.
     * Selected stream at 65% container size centered at full opacity.
     * Others fanned behind with decreasing size, opacity, and zIndex.
     */
    function densityGridZDepth(container, streams, selectedIdx) {
        var count = streams.length;
        var idx = (selectedIdx >= 0 && selectedIdx < count) ? selectedIdx : 0;
        var cells = [];

        // Selected stream: 65% of container, centered
        var heroW = container.width * 0.65;
        var heroH = container.height * 0.65;
        var heroAR = streams[idx].aspectRatio || 16 / 9;
        var heroFit = fitToContainer({ width: heroW, height: heroH }, heroAR);

        cells.push({
            streamId: streams[idx].id,
            x: (container.width - heroFit.width) / 2,
            y: (container.height - heroFit.height) / 2,
            width: heroFit.width,
            height: heroFit.height,
            zIndex: 100,
            opacity: 1,
            transform: 'none'
        });

        // Fan remaining streams behind the hero
        var others = [];
        for (var i = 0; i < count; i++) {
            if (i !== idx) others.push(streams[i]);
        }

        var otherCount = others.length;
        for (var j = 0; j < otherCount; j++) {
            // Distribute evenly across container width
            var position = (j + 1) / (otherCount + 1); // 0..1 spread
            var scale = Math.max(0.25, 0.55 - j * 0.05);
            var w = container.width * scale;
            var h = container.height * scale;
            var ar = others[j].aspectRatio || 16 / 9;
            var fit = fitToContainer({ width: w, height: h }, ar);

            var xPos = container.width * position - fit.width / 2;
            var yPos = (container.height - fit.height) / 2 + (j % 2 === 0 ? -15 : 15);

            cells.push({
                streamId: others[j].id,
                x: xPos,
                y: yPos,
                width: fit.width,
                height: fit.height,
                zIndex: 50 - j * 5,
                opacity: Math.max(0.2, 0.7 - j * 0.1),
                transform: 'none'
            });
        }

        return { cells: cells, rows: 1, cols: count, mode: 'density-grid-zdepth', selectedIndex: idx };
    }

    /**
     * Grid variant 2: Content-visible — standard grid with contain fit.
     * No cropping so all video content is visible (styled via density CSS classes).
     */
    function densityGridContentVisible(container, streams) {
        var layout = calculateLayout(container, streams);
        layout.mode = 'density-grid-content-visible';
        return layout;
    }

    /**
     * Density 3: Fill — edge-to-edge dense layouts.
     * Variant 0: Crop tiles — cover grid with wallCropZoom
     * Variant 1: Skyline bin-pack — columns with aspect-aware placement
     * Variant 2: Masonry column-pack — shortest-column-first (Pinterest style)
     */
    function densityFill(variant, container, streams, selectedIdx) {
        if (variant === 1) {
            return densityFillSkyline(container, streams);
        }
        if (variant === 2) {
            return densityFillMasonry(container, streams);
        }
        // Variant 0: Crop tiles
        return densityFillCropTiles(container, streams, selectedIdx);
    }

    /**
     * Fill variant 0: Crop tiles — edge-to-edge grid, all cover, with wallCropZoom.
     * Finds optimal rows/cols that maximize 16:9 cell aspect ratio.
     */
    function densityFillCropTiles(container, streams, selectedIdx) {
        var count = streams.length;
        var idx = (selectedIdx >= 0 && selectedIdx < count) ? selectedIdx : -1;
        var targetAR = 16 / 9;
        var bestRows = 1, bestCols = count, bestScore = -Infinity;

        for (var rows = 1; rows <= count; rows++) {
            var cols = Math.ceil(count / rows);
            var emptyCells = rows * cols - count;
            if (emptyCells >= cols) continue;

            var cellW = container.width / cols;
            var cellH = container.height / rows;
            var cellAR = cellW / cellH;
            var ratioScore = 1 - Math.abs(cellAR - targetAR) / targetAR;
            var fillScore = count / (rows * cols);
            var score = ratioScore * 0.6 + fillScore * 0.4;

            if (score > bestScore) {
                bestScore = score;
                bestRows = rows;
                bestCols = cols;
            }
        }

        var cellH = container.height / bestRows;
        var cells = [];
        var si = 0;

        for (var r = 0; r < bestRows && si < count; r++) {
            var remaining = count - si;
            var inRow = (r === bestRows - 1) ? remaining : Math.min(bestCols, remaining);
            var cellW = container.width / inRow;

            for (var c = 0; c < inRow; c++) {
                var isSelected = (si === idx);
                cells.push({
                    streamId: streams[si].id,
                    x: c * cellW,
                    y: r * cellH,
                    width: cellW,
                    height: cellH,
                    objectFit: 'cover',
                    wallCropZoom: isSelected ? 2.2 : 1.8,
                    isWallCropSelected: isSelected
                });
                si++;
            }
        }

        return { cells: cells, rows: bestRows, cols: bestCols, mode: 'density-fill', efficiency: 1.0 };
    }

    /**
     * Fill variant 1: Skyline bin-pack.
     * Determines column count from stream count and aspect ratios.
     * Tracks per-column height (skyline), places each stream at the shortest column.
     * Scales to fit container height.
     */
    function densityFillSkyline(container, streams) {
        var count = streams.length;
        var gap = 2;

        // Determine column count: ~sqrt(count) biased by container aspect ratio
        var containerAR = container.width / container.height;
        var baseCols = Math.round(Math.sqrt(count * containerAR));
        var cols = Math.max(1, Math.min(count, baseCols));
        var colWidth = (container.width - gap * (cols - 1)) / cols;

        // Skyline: track height of each column
        var skyline = [];
        for (var c = 0; c < cols; c++) skyline.push(0);

        var cells = [];

        for (var i = 0; i < count; i++) {
            var s = streams[i];
            var ar = (s.video && s.video.videoWidth && s.video.videoHeight)
                ? s.video.videoWidth / s.video.videoHeight
                : (s.aspectRatio || 16 / 9);

            // Cell height determined by aspect ratio
            var cellH = colWidth / ar;

            // Find the shortest column
            var minCol = 0;
            for (var c = 1; c < cols; c++) {
                if (skyline[c] < skyline[minCol]) minCol = c;
            }

            cells.push({
                streamId: s.id,
                x: minCol * (colWidth + gap),
                y: skyline[minCol],
                width: colWidth,
                height: cellH,
                objectFit: 'cover'
            });

            skyline[minCol] += cellH + gap;
        }

        // Find max skyline height and scale everything to fit container
        var maxH = 0;
        for (var c = 0; c < cols; c++) {
            if (skyline[c] > maxH) maxH = skyline[c];
        }

        if (maxH > 0 && maxH !== container.height) {
            var scale = container.height / maxH;
            for (var i = 0; i < cells.length; i++) {
                cells[i].x *= scale;
                cells[i].y *= scale;
                cells[i].width *= scale;
                cells[i].height *= scale;
            }
        }

        var rows = Math.ceil(count / cols);
        return { cells: cells, rows: rows, cols: cols, mode: 'density-fill-skyline' };
    }

    /**
     * Fill variant 2: Masonry / column-pack (Pinterest-style).
     * Shortest column gets the next item. Respects stream aspect ratios.
     * 2px gaps between items.
     */
    function densityFillMasonry(container, streams) {
        var count = streams.length;
        var gap = 2;

        // Column count: similar heuristic as skyline
        var containerAR = container.width / container.height;
        var cols = Math.max(1, Math.min(count, Math.round(Math.sqrt(count * containerAR))));
        var colWidth = (container.width - gap * (cols - 1)) / cols;

        // Track column heights
        var colHeights = [];
        for (var c = 0; c < cols; c++) colHeights.push(0);

        var cells = [];

        for (var i = 0; i < count; i++) {
            var s = streams[i];
            var ar = (s.video && s.video.videoWidth && s.video.videoHeight)
                ? s.video.videoWidth / s.video.videoHeight
                : (s.aspectRatio || 16 / 9);

            var cellH = colWidth / ar;

            // Shortest column
            var minCol = 0;
            for (var c = 1; c < cols; c++) {
                if (colHeights[c] < colHeights[minCol]) minCol = c;
            }

            cells.push({
                streamId: s.id,
                x: minCol * (colWidth + gap),
                y: colHeights[minCol],
                width: colWidth,
                height: cellH,
                objectFit: 'contain'
            });

            colHeights[minCol] += cellH + gap;
        }

        // Scale to fit container vertically
        var maxH = 0;
        for (var c = 0; c < cols; c++) {
            if (colHeights[c] > maxH) maxH = colHeights[c];
        }
        if (maxH > 0 && maxH !== container.height) {
            var scale = container.height / maxH;
            for (var i = 0; i < cells.length; i++) {
                cells[i].x *= scale;
                cells[i].y *= scale;
                cells[i].width *= scale;
                cells[i].height *= scale;
            }
        }

        var rows = Math.ceil(count / cols);
        return { cells: cells, rows: rows, cols: cols, mode: 'density-fill-masonry' };
    }

    /**
     * Density 4: Strips — thin continuous strips.
     * Variant 0: Vertical columns (reuses existing strips layout)
     * Variant 1: Horizontal rows — full-width rows stacked vertically
     */
    function densityStrips(variant, container, streams, selectedIdx) {
        if (variant === 1) {
            return densityStripsHorizontal(container, streams);
        }
        // Variant 0: vertical columns
        var layout = calculateStripsLayout(container, streams);
        layout.mode = 'density-strips';
        return layout;
    }

    /**
     * Strips variant 1: Horizontal rows.
     * Each stream gets a full-width row, height = container.height / count.
     */
    function densityStripsHorizontal(container, streams) {
        var count = streams.length;
        var rowHeight = container.height / count;

        var cells = streams.map(function(s, i) {
            return {
                streamId: s.id,
                x: 0,
                y: i * rowHeight,
                width: container.width,
                height: rowHeight,
                objectFit: 'cover'
            };
        });

        return { cells: cells, rows: count, cols: 1, mode: 'density-strips' };
    }

    /**
     * Density 5: Mosaic — maximum stream density.
     * Variant 0: Mosaic grid — returns signal for CSS grid positioning
     * Variant 1: Bug Eye — returns signal for canvas overlay activation
     */
    function densityMosaic(variant, container, streams, selectedIdx) {
        if (variant === 1) {
            return { type: 'overlay', mode: 'bugeye' };
        }

        // Variant 0: Mosaic grid signal — cells have streamId but zero positions
        // (CSS grid handles actual positioning in app.js)
        var cells = streams.map(function(s) {
            return {
                streamId: s.id,
                x: 0,
                y: 0,
                width: 0,
                height: 0
            };
        });

        return { type: 'mosaic-grid', cells: cells, rows: 0, cols: 0, mode: 'density-mosaic' };
    }

    // Public API
    return {
        calculateLayout,
        calculateCoverflowLayout,
        calculateTetrisLayout,
        calculateStripsLayout,
        calculateSpotlightLayout,
        calculateDensityLayout,
        applyLayout,
        onContainerResize,
        fitToContainer,
        calculateEfficiency,
        // Coverflow navigation
        coverflowNavigate,
        getCoverflowSelectedIndex,
        setCoverflowSelectedIndex
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlexdGrid;
}
