<?php

function wp_lab_where($callback) {
	try {
		if (is_string($callback) && strpos($callback, '::') !== false) {
			$callback = explode('::', $callback, 2);
		}
		if (is_array($callback)) {
			$ref = new ReflectionMethod($callback[0], $callback[1]);
			$name = (is_object($callback[0]) ? get_class($callback[0]) : $callback[0]) . '::' . $callback[1];
		} elseif (is_object($callback) && !($callback instanceof Closure)) {
			$ref = new ReflectionMethod($callback, '__invoke');
			$name = get_class($callback) . '::__invoke';
		} else {
			$ref = new ReflectionFunction($callback);
			$name = $callback instanceof Closure ? 'closure' : $callback;
		}
		$file = (string) $ref->getFileName();
		return array('name' => $name, 'file' => str_replace(WP_CONTENT_DIR . '/', '', $file), 'line' => $ref->getStartLine(), 'third_party' => strpos($file, WP_CONTENT_DIR . '/plugins/') === 0 || strpos($file, WP_CONTENT_DIR . '/themes/') === 0, 'checks' => wp_lab_checks($file, $ref->getStartLine(), $ref->getEndLine()));
	} catch (Throwable $e) {
		return array('name' => is_string($callback) ? $callback : 'unknown', 'file' => null, 'line' => null, 'third_party' => false, 'checks' => null);
	}
}

function wp_lab_checks($file, $start, $end) {
	if (!$file || !is_readable($file) || !$start || !$end) {
		return null;
	}
	$body = implode('', array_slice(file($file), $start - 1, $end - $start + 1));
	$nonce = array();
	if (preg_match_all('/(check_ajax_referer|wp_verify_nonce|check_admin_referer)\s*\(\s*([^,)]+)?(?:,\s*([^,)]+))?/', $body, $m, PREG_SET_ORDER)) {
		foreach ($m as $x) {
			$nonce[] = $x[1] === 'wp_verify_nonce' ? trim(isset($x[3]) ? $x[3] : '?') : trim(isset($x[2]) && $x[2] !== '' ? $x[2] : '-1');
		}
	}
	$caps = array();
	if (preg_match_all('/(current_user_can|user_can)\s*\(\s*(?:[^,()]+,\s*)?([^,)]+)/', $body, $m, PREG_SET_ORDER)) {
		foreach ($m as $x) {
			$caps[] = trim($x[2]);
		}
	}
	return array('nonce' => array_values(array_unique($nonce)), 'caps' => array_values(array_unique($caps)), 'is_admin_only' => (bool) preg_match('/\bis_admin\s*\(/', $body));
}

function wp_lab_permission($p) {
	if ($p === null) {
		return 'MISSING';
	}
	if ($p === '__return_true') {
		return '__return_true (public)';
	}
	$where = wp_lab_where($p);
	return $where['name'] . ($where['file'] ? ' @ ' . $where['file'] . ':' . $where['line'] : '');
}

function wp_lab_respond() {
	$what = isset($_REQUEST['wp_lab']) ? sanitize_key(wp_unslash($_REQUEST['wp_lab'])) : 'whoami';
	$user = wp_get_current_user();
	$out = array('user' => $user->exists() ? $user->user_login : null, 'roles' => array_values($user->roles));
	if ($what === 'nonce') {
		$action = isset($_REQUEST['nonce_action']) ? wp_unslash($_REQUEST['nonce_action']) : -1;
		$out['action'] = $action;
		$out['nonce'] = wp_create_nonce($action);
		$out['rest_nonce'] = wp_create_nonce('wp_rest');
	}
	if ($what === 'status') {
		if (!function_exists('get_plugins')) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		$out['wordpress'] = get_bloginfo('version');
		$out['php'] = PHP_VERSION;
		$out['plugins'] = array();
		foreach (get_plugins() as $file => $data) {
			$out['plugins'][] = array('file' => $file, 'name' => $data['Name'], 'version' => $data['Version'], 'active' => is_plugin_active($file));
		}
		$theme = wp_get_theme();
		$out['theme'] = array('slug' => $theme->get_stylesheet(), 'name' => $theme->get('Name'), 'version' => $theme->get('Version'));
	}
	if ($what === 'surface') {
		global $wp_filter;
		$ajax = array();
		foreach ($wp_filter as $hook => $handlers) {
			$nopriv = strpos($hook, 'wp_ajax_nopriv_') === 0;
			if (!$nopriv && strpos($hook, 'wp_ajax_') !== 0) {
				continue;
			}
			$action = substr($hook, $nopriv ? 15 : 8);
			if (strpos($action, 'wp_lab') === 0) {
				continue;
			}
			foreach ($handlers->callbacks as $priority => $callbacks) {
				foreach ($callbacks as $cb) {
					$where = wp_lab_where($cb['function']);
					if ($where['third_party']) {
						$ajax[] = array('action' => $action, 'nopriv' => $nopriv, 'handler' => $where['name'], 'file' => $where['file'], 'line' => $where['line'], 'checks' => $where['checks']);
					}
				}
			}
		}
		$rest = array();
		foreach (rest_get_server()->get_routes() as $route => $handlers) {
			foreach ($handlers as $h) {
				$where = wp_lab_where($h['callback']);
				if (!$where['third_party']) {
					continue;
				}
				$rest[] = array('route' => $route, 'methods' => implode(',', array_keys($h['methods'])), 'permission' => wp_lab_permission(isset($h['permission_callback']) ? $h['permission_callback'] : null), 'handler' => $where['name'], 'file' => $where['file'], 'line' => $where['line'], 'checks' => $where['checks']);
			}
		}
		$shortcodes = array();
		global $shortcode_tags;
		foreach ($shortcode_tags as $tag => $cb) {
			$where = wp_lab_where($cb);
			if ($where['third_party']) {
				$shortcodes[] = array('tag' => $tag, 'handler' => $where['name'], 'file' => $where['file'], 'line' => $where['line']);
			}
		}
		$out['ajax'] = $ajax;
		$out['rest'] = $rest;
		$out['shortcodes'] = $shortcodes;
	}
	if ($what === 'php') {
		if (!current_user_can('manage_options')) {
			wp_send_json(array('error' => 'php needs an administrator session'), 403);
		}
		$code = isset($_POST['code']) ? wp_unslash($_POST['code']) : '';
		$code = preg_replace('/^\s*<\?php\s*/', '', $code);
		ob_start();
		try {
			$value = eval($code);
			$out['output'] = ob_get_clean();
			$out['return'] = $value;
		} catch (Throwable $e) {
			$out['output'] = ob_get_clean();
			$out['error'] = get_class($e) . ': ' . $e->getMessage() . ' on line ' . $e->getLine();
		}
	}
	if ($what === 'log-test') {
		error_log('wp-lab: debug log works');
		$out['logged'] = true;
	}
	wp_send_json($out);
}

add_action('wp_ajax_wp_lab', 'wp_lab_respond');
add_action('wp_ajax_nopriv_wp_lab', 'wp_lab_respond');
