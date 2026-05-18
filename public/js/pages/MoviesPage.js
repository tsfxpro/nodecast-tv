/**
 * Movies Page Controller
 * Handles VOD movie browsing and playback
 */

class MoviesPage {
    constructor(app) {
        this.app = app;
        this.container = document.getElementById('movies-grid');
        this.sourceSelect = document.getElementById('movies-source-select');
        this.categorySelect = document.getElementById('movies-category-select');
        this.searchInput = document.getElementById('movies-search');

        this.movies = [];
        this.categories = [];
        this.sources = [];
        this.currentBatch = 0;
        this.batchSize = 24;
        this.filteredMovies = [];
        this.isLoading = false;
        this.observer = null;
        this.favoriteIds = new Set(); // Track favorite movie IDs
        this.showFavoritesOnly = false;

        this.init();
    }

    init() {
        // Source change handler
        this.sourceSelect?.addEventListener('change', async () => {
            await this.loadCategories();
            await this.loadMovies();
        });

        // Category change handler
        this.categorySelect?.addEventListener('change', () => {
            this.loadMovies();
        });

        // Search with debounce
        let searchTimeout;
        this.searchInput?.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => this.filterAndRender(), 300);
        });

        // Set up IntersectionObserver for lazy loading
        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.isLoading) {
                this.renderNextBatch();
            }
        }, { rootMargin: '200px' });

        // Favorites filter toggle
        const favBtn = document.getElementById('movies-favorites-btn');
        favBtn?.addEventListener('click', () => {
            this.showFavoritesOnly = !this.showFavoritesOnly;
            favBtn.classList.toggle('active', this.showFavoritesOnly);
            this.filterAndRender();
        });
    }

    async show() {
        // Load sources if not loaded
        if (this.sources.length === 0) {
            await this.loadSources();
        }

        // Load favorites
        await this.loadFavorites();

        // Load movies if empty
        if (this.movies.length === 0) {
            await this.loadCategories();
            await this.loadMovies();
        }
    }

    hide() {
        // Page is hidden
    }

    async loadFavorites() {
        try {
            const favs = await API.favorites.getAll(null, 'movie');
            this.favoriteIds = new Set(favs.map(f => `${f.source_id}:${f.item_id}`));
        } catch (err) {
            console.error('Error loading favorites:', err);
        }
    }


    async loadSources() {
        try {
            const allSources = await API.sources.getAll();
            this.sources = allSources.filter(s => s.type === 'xtream' && s.enabled);

            this.sourceSelect.innerHTML = '<option value="">All Sources</option>';
            this.sources.forEach(s => {
                const option = document.createElement('option');
                option.value = s.id;
                option.textContent = s.name;
                this.sourceSelect.appendChild(option);
            });
        } catch (err) {
            console.error('Error loading sources:', err);
        }
    }

    async loadCategories() {
        try {
            this.categories = [];
            this.hiddenCategoryIds = new Set();
            this.categorySelect.innerHTML = '<option value="">All Categories</option>';

            const sourceId = this.sourceSelect.value;
            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            // Fetch hidden items and categories in parallel across all sources
            const results = await Promise.all(sourcesToLoad.map(async (source) => {
                const [hiddenItems, cats] = await Promise.all([
                    API.channels.getHidden(source.id).catch(() => []),
                    API.proxy.xtream.vodCategories(source.id).catch(() => [])
                ]);
                return { source, hiddenItems, cats };
            }));

            for (const { source, hiddenItems } of results) {
                hiddenItems.forEach(h => {
                    if (h.item_type === 'vod_category') {
                        this.hiddenCategoryIds.add(`${source.id}:${h.item_id}`);
                    }
                });
            }

            for (const { source, cats } of results) {
                if (cats && Array.isArray(cats)) {
                    cats.forEach(c => {
                        if (!this.hiddenCategoryIds.has(`${source.id}:${c.category_id}`)) {
                            this.categories.push({ ...c, sourceId: source.id });
                        }
                    });
                }
            }

            // Populate dropdown
            this.categories.forEach(c => {
                const option = document.createElement('option');
                option.value = `${c.sourceId}:${c.category_id}`;
                option.textContent = c.category_name;
                this.categorySelect.appendChild(option);
            });
        } catch (err) {
            console.error('Error loading categories:', err);
        }
    }

    async loadMovies() {
        this.isLoading = true;
        this.container.innerHTML = '<div class="loading"><div class="loading-spinner"></div></div>';

        try {
            this.movies = [];

            const sourceId = this.sourceSelect.value;
            const categoryValue = this.categorySelect.value;

            const sourcesToLoad = sourceId
                ? this.sources.filter(s => s.id === parseInt(sourceId))
                : this.sources;

            const movieResults = await Promise.all(sourcesToLoad.map(async (source) => {
                let catId = null;
                if (categoryValue) {
                    const [catSourceId, categoryId] = categoryValue.split(':');
                    if (parseInt(catSourceId) === source.id) {
                        catId = categoryId;
                    } else if (sourceId) {
                        return null; // Skip: category belongs to a different source
                    }
                }
                try {
                    const movies = await API.proxy.xtream.vodStreams(source.id, catId);
                    console.log(`[Movies] Source ${source.id}, Category ${catId || 'ALL'}: Got ${movies?.length || 0} movies`);
                    return { source, movies: movies || [] };
                } catch (err) {
                    console.warn(`Failed to load movies from source ${source.id}:`, err.message);
                    return { source, movies: [] };
                }
            }));

            for (const result of movieResults) {
                if (!result) continue;
                const { source, movies } = result;
                movies.forEach(m => {
                    if (this.hiddenCategoryIds && this.hiddenCategoryIds.has(`${source.id}:${m.category_id}`)) return;
                    this.movies.push({ ...m, sourceId: source.id, id: `${source.id}:${m.stream_id}` });
                });
            }

            console.log(`[Movies] Total loaded: ${this.movies.length} movies`);
            this.filterAndRender();
        } catch (err) {
            console.error('Error loading movies:', err);
            this.container.innerHTML = '<div class="empty-state"><p>Error loading movies</p></div>';
        } finally {
            this.isLoading = false;
        }
    }

    filterAndRender() {
        const searchTerm = this.searchInput?.value?.toLowerCase() || '';

        this.filteredMovies = this.movies.filter(m => {
            // Filter by favorites if enabled
            if (this.showFavoritesOnly) {
                const favKey = `${m.sourceId}:${m.stream_id}`;
                if (!this.favoriteIds.has(favKey)) return false;
            }
            if (searchTerm && !m.name?.toLowerCase().includes(searchTerm)) {
                return false;
            }
            return true;
        });

        console.log(`[Movies] Displaying ${this.filteredMovies.length} of ${this.movies.length} movies`);

        this.currentBatch = 0;
        this.container.innerHTML = '';

        if (this.filteredMovies.length === 0) {
            this.container.innerHTML = '<div class="empty-state"><p>No movies found</p></div>';
            return;
        }

        // Create loader element
        const loader = document.createElement('div');
        loader.className = 'movies-loader';
        loader.innerHTML = '<div class="loading-spinner"></div>';
        this.container.appendChild(loader);

        // Render initial batches (more to fill viewport)
        for (let i = 0; i < 5; i++) {
            this.renderNextBatch();
        }

        // Start observing loader
        this.observer.observe(loader);
    }

    renderNextBatch() {
        const start = this.currentBatch * this.batchSize;
        const end = start + this.batchSize;
        const batch = this.filteredMovies.slice(start, end);

        console.log(`[Movies] Rendering batch ${this.currentBatch}: ${batch.length} cards (${start}-${end})`);

        if (batch.length === 0) {
            const loader = this.container.querySelector('.movies-loader');
            if (loader) loader.style.display = 'none';
            return;
        }

        const fragment = document.createDocumentFragment();

        batch.forEach(movie => {
            const card = document.createElement('div');
            card.className = 'movie-card';
            card.dataset.movieId = movie.stream_id;
            card.dataset.sourceId = movie.sourceId;

            const poster = movie.stream_icon || movie.cover || '/img/placeholder.png';
            const year = movie.year || movie.releaseDate?.substring(0, 4) || '';
            const rating = movie.rating ? `${Icons.star} ${movie.rating}` : '';

            const isFav = this.favoriteIds.has(`${movie.sourceId}:${movie.stream_id}`);

            card.innerHTML = `
                <div class="movie-poster">
                    <img src="${poster}" alt="${movie.name}" 
                         onerror="this.onerror=null;this.src='/img/placeholder.png'" loading="lazy">
                    <div class="movie-play-overlay">
                        <span class="play-icon">${Icons.play}</span>
                    </div>
                    <button class="favorite-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}">
                        <span class="fav-icon">${isFav ? Icons.favorite : Icons.favoriteOutline}</span>
                    </button>
                </div>
                <div class="movie-info">
                    <div class="movie-title">${movie.name}</div>
                    <div class="movie-meta">
                        ${year ? `<span>${year}</span>` : ''}
                        ${rating ? `<span>${rating}</span>` : ''}
                    </div>
                </div>
            `;

            // Card click plays movie, but not if clicking favorite button
            card.addEventListener('click', (e) => {
                if (e.target.closest('.favorite-btn')) {
                    const btn = e.target.closest('.favorite-btn');
                    this.toggleFavorite(movie, btn);
                    e.stopPropagation();
                } else {
                    this.playMovie(movie);
                }
            });
            fragment.appendChild(card);
        });

        // Insert before loader
        const loader = this.container.querySelector('.movies-loader');
        if (loader) {
            this.container.insertBefore(fragment, loader);
        } else {
            this.container.appendChild(fragment);
        }

        this.currentBatch++;

        // Hide loader if done
        if (end >= this.filteredMovies.length && loader) {
            loader.style.display = 'none';
        }
    }

    async playMovie(movie) {
        try {
            // Get stream URL for movie using the actual container extension from API
            // Xtream API returns container_extension (e.g., 'mp4', 'mkv', 'avi')
            const container = movie.container_extension || 'mp4';
            const result = await API.proxy.xtream.getStreamUrl(movie.sourceId, movie.stream_id, 'movie', container);

            if (result && result.url) {
                // Play in dedicated Watch page
                if (this.app.pages.watch) {
                    this.app.pages.watch.play({
                        type: 'movie',
                        id: movie.stream_id,
                        title: movie.name,
                        poster: movie.stream_icon || movie.cover,
                        description: movie.plot || '',
                        year: movie.year || movie.releaseDate?.substring(0, 4),
                        rating: movie.rating,
                        sourceId: movie.sourceId,
                        categoryId: movie.category_id,
                        containerExtension: container
                    }, result.url);
                }
            }
        } catch (err) {
            console.error('Error playing movie:', err);
        }
    }
    async toggleFavorite(movie, btn) {
        const favKey = `${movie.sourceId}:${movie.stream_id}`;
        const isFav = this.favoriteIds.has(favKey);
        const iconSpan = btn.querySelector('.fav-icon');

        try {
            // Optimistic update
            if (isFav) {
                this.favoriteIds.delete(favKey);
                btn.classList.remove('active');
                btn.title = 'Add to Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
                await API.favorites.remove(movie.sourceId, movie.stream_id, 'movie');
            } else {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                btn.title = 'Remove from Favorites';
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
                await API.favorites.add(movie.sourceId, movie.stream_id, 'movie');
            }
        } catch (err) {
            console.error('Error toggling favorite:', err);
            // Revert on error
            if (isFav) {
                this.favoriteIds.add(favKey);
                btn.classList.add('active');
                if (iconSpan) iconSpan.innerHTML = Icons.favorite;
            } else {
                this.favoriteIds.delete(favKey);
                btn.classList.remove('active');
                if (iconSpan) iconSpan.innerHTML = Icons.favoriteOutline;
            }
        }
    }
}

window.MoviesPage = MoviesPage;
