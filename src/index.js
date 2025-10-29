const {createBullBoard} = require('@bull-board/api');
const {BullAdapter} = require('@bull-board/api/bullAdapter');
const {BullMQAdapter} = require('@bull-board/api/bullMQAdapter');
const {ExpressAdapter} = require('@bull-board/express');
const Queue = require('bull');
const bullmq = require('bullmq');
const express = require('express');
const redis = require('redis');
const session = require('express-session');
const passport = require('passport');
const {ensureLoggedIn} = require('connect-ensure-login');
const bodyParser = require('body-parser');

const {authRouter} = require('./login');
const config = require('./config');

const redisConfig = {
	redis: {
		port: config.REDIS_PORT,
		host: config.REDIS_HOST,
		db: config.REDIS_DB,
		...(config.REDIS_PASSWORD && {password: config.REDIS_PASSWORD}),
		tls: config.REDIS_USE_TLS === 'true',
	},
};

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath(config.HOME_PAGE);

const {setQueues, replaceQueues} = createBullBoard({queues: [], serverAdapter});
const router = serverAdapter.getRouter();

// Store queue list globally so we can access it later
let queueList = [];

// Redis v4 requires async/await and connect()
const clientConfig = {
	socket: {
		port: config.REDIS_PORT,
		host: config.REDIS_HOST,
		tls: config.REDIS_USE_TLS === 'true',
	},
	database: config.REDIS_DB,
};

if (config.REDIS_PASSWORD) {
	clientConfig.password = config.REDIS_PASSWORD;
}

const client = redis.createClient(clientConfig);

(async () => {
	await client.connect();

	const keys = await client.keys(`${config.BULL_PREFIX}:*`);
	const uniqKeys = new Set(keys.map(key => key.replace(/^.+?:(.+?):.+?$/, '$1')));
	queueList = Array.from(uniqKeys).sort().map(
		(item) => {
			if (config.BULL_VERSION === 'BULLMQ') {
				const options = { connection: redisConfig.redis };
				if (config.BULL_PREFIX) {
					options.prefix = config.BULL_PREFIX;
				}
				return new BullMQAdapter(new bullmq.Queue(item, options));
			}

			return new BullAdapter(new Queue(item, redisConfig));
		}
	);

	setQueues(queueList);
	console.log('done!');
})().catch(err => {
	console.error('Error setting up queues:', err);
});

const app = express();

app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');

if (app.get('env') !== 'production') {
	const morgan = require('morgan');
	app.use(morgan('combined'));
}

app.use((req, res, next) => {
	if (config.PROXY_PATH) {
		req.proxyUrl = config.PROXY_PATH;
	}

	next();
});

const sessionOpts = {
	name: 'bull-board.sid',
	secret: Math.random().toString(),
	resave: false,
	saveUninitialized: false,
	cookie: {
		path: '/',
		httpOnly: false,
		secure: false
	}
};

app.use(session(sessionOpts));
app.use(passport.initialize({}));
app.use(passport.session({}));
app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

// Custom endpoint to clean all queues
const cleanAllQueuesHandler = async (req, res) => {
	try {
		const results = [];
		for (const queueAdapter of queueList) {
			const queue = queueAdapter.queue;
			const queueName = queue.name;

			try {
				await queue.obliterate({ force: true });
				results.push({ queue: queueName, status: 'success' });
			} catch (err) {
				results.push({ queue: queueName, status: 'error', error: err.message });
			}
		}

		res.json({ success: true, results });
	} catch (err) {
		res.status(500).json({ success: false, error: err.message });
	}
};

// Register API endpoint BEFORE Bull Board router
// Log the route being registered for debugging
console.log(`Registering clean-all-queues endpoint at: ${config.HOME_PAGE}/api/clean-all-queues`);
console.log(`AUTH_ENABLED: ${config.AUTH_ENABLED}`);

if (config.AUTH_ENABLED) {
	app.use(config.LOGIN_PAGE, authRouter);
	// Try both with and without ensureLoggedIn to see if auth is the issue
	app.post(`${config.HOME_PAGE}/api/clean-all-queues`, cleanAllQueuesHandler);
} else {
	app.post(`${config.HOME_PAGE}/api/clean-all-queues`, cleanAllQueuesHandler);
}

// Also register without the HOME_PAGE prefix as a fallback
app.post('/api/clean-all-queues', cleanAllQueuesHandler);

// Middleware to inject custom button into Bull Board UI
const injectButtonMiddleware = (req, res, next) => {
	if (req.path === '/' || req.path === '') {
		const originalSend = res.send;
		res.send = function(data) {
			if (typeof data === 'string' && data.includes('<!DOCTYPE html>')) {
				// Inject custom button and script
				const customScript = `
					<script>
						function addCleanAllButton() {
							const targetDiv = document.querySelector('header') || document.querySelector('nav') || document.body;
							if (!document.getElementById('clean-all-queues-btn')) {
								const button = document.createElement('button');
								button.id = 'clean-all-queues-btn';
								button.textContent = 'Clean All Queues';
								button.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 9999; padding: 12px 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: all 0.3s ease; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;';

								// Add hover effect
								button.onmouseenter = function() {
									this.style.transform = 'translateY(-2px)';
									this.style.boxShadow = '0 6px 20px rgba(102, 126, 234, 0.6)';
								};
								button.onmouseleave = function() {
									this.style.transform = 'translateY(0)';
									this.style.boxShadow = '0 4px 15px rgba(102, 126, 234, 0.4)';
								};

								button.onclick = async function() {
									if (!confirm('Are you sure you want to clean ALL queues? This will remove all jobs from all queues!')) {
										return;
									}

									button.disabled = true;
									button.textContent = 'Cleaning...';

									try {
										const basePath = '${config.HOME_PAGE}' === '/' ? '' : '${config.HOME_PAGE}';
										const apiUrl = basePath + '/api/clean-all-queues';
										const response = await fetch(apiUrl, {
											method: 'POST',
											headers: {
												'Content-Type': 'application/json'
											}
										});

										const result = await response.json();

										if (result.success) {
											alert('All queues cleaned successfully!\\n\\n' +
												result.results.map(r => r.queue + ': ' + r.status).join('\\n'));
											window.location.reload();
										} else {
											alert('Error cleaning queues: ' + result.error);
										}
									} catch (err) {
										alert('Error: ' + err.message);
									} finally {
										button.disabled = false;
										button.textContent = 'Clean All Queues';
									}
								};

								document.body.appendChild(button);
							}
						}

						// Try to add button when DOM is ready
						if (document.readyState === 'loading') {
							document.addEventListener('DOMContentLoaded', addCleanAllButton);
						} else {
							addCleanAllButton();
						}

						// Also try after a short delay to ensure React has rendered
						setTimeout(addCleanAllButton, 500);
						setTimeout(addCleanAllButton, 1500);
					</script>
				`;

				data = data.replace('</body>', customScript + '</body>');
			}
			originalSend.call(this, data);
		};
	}
	next();
};

if (config.AUTH_ENABLED) {
	app.use(config.HOME_PAGE, ensureLoggedIn(config.LOGIN_PAGE), injectButtonMiddleware, router);
} else {
	app.use(config.HOME_PAGE, injectButtonMiddleware, router);
}

app.listen(config.PORT, () => {
	console.log(`bull-board is started http://localhost:${config.PORT}${config.HOME_PAGE}`);
	console.log(`bull-board is fetching queue list, please wait...`);
});
