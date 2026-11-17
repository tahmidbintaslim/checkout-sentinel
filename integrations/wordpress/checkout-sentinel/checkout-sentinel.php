<?php
/**
 * Plugin Name:       Checkout Sentinel
 * Description:       Reports plugin, theme and WordPress updates to Checkout Sentinel, so a checkout failure alert can name the change that came just before it.
 * Version:           0.1.0
 * Requires at least: 6.4
 * Requires PHP:      7.4
 * Author:            Checkout Sentinel
 * License:           MIT
 * Text Domain:       checkout-sentinel
 *
 * The plugin only sends what changed (names and versions of plugins, themes and WordPress
 * itself) to the API address set in Settings > Checkout Sentinel. It sends nothing about
 * customers or orders, and nothing at all until an API key is saved.
 */

if (!defined('ABSPATH')) {
	exit;
}

define('CHECKOUT_SENTINEL_OPTION', 'checkout_sentinel_settings');
define('CHECKOUT_SENTINEL_STATUS_OPTION', 'checkout_sentinel_last_report');

/** Saved settings: api_url (no trailing slash) and api_key. */
function checkout_sentinel_settings() {
	$saved = get_option(CHECKOUT_SENTINEL_OPTION, array());
	return array(
		'api_url' => isset($saved['api_url']) ? (string) $saved['api_url'] : '',
		'api_key' => isset($saved['api_key']) ? (string) $saved['api_key'] : '',
	);
}

/**
 * Sends one change to POST /api/changes. Returns true when the API accepted it. The outcome
 * is kept for the settings page; failures never interrupt the update that triggered them.
 */
function checkout_sentinel_report($kind, $summary) {
	$settings = checkout_sentinel_settings();
	if ($settings['api_url'] === '' || $settings['api_key'] === '') {
		return false;
	}
	$response = wp_remote_post(
		$settings['api_url'] . '/api/changes',
		array(
			'timeout' => 5,
			'headers' => array(
				'Authorization' => 'Bearer ' . $settings['api_key'],
				'Content-Type'  => 'application/json',
			),
			'body'    => wp_json_encode(
				array(
					'store'      => home_url('/'),
					'kind'       => $kind,
					'summary'    => mb_substr($summary, 0, 500),
					'occurredAt' => gmdate('Y-m-d\TH:i:s\Z'),
				)
			),
		)
	);
	$code = is_wp_error($response) ? 0 : (int) wp_remote_retrieve_response_code($response);
	update_option(
		CHECKOUT_SENTINEL_STATUS_OPTION,
		array(
			'at'      => time(),
			'ok'      => $code >= 200 && $code < 300,
			'summary' => $summary,
			'error'   => is_wp_error($response) ? $response->get_error_message() : ($code >= 300 ? 'HTTP ' . $code : ''),
		),
		false
	);
	return $code >= 200 && $code < 300;
}

/** A plugin's display name and version, from its main file under wp-content/plugins. */
function checkout_sentinel_plugin_label($plugin_file) {
	$path = WP_PLUGIN_DIR . '/' . $plugin_file;
	if (!function_exists('get_plugin_data')) {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
	}
	$data = file_exists($path) ? get_plugin_data($path, false, false) : array();
	$name = !empty($data['Name']) ? $data['Name'] : dirname($plugin_file);
	return !empty($data['Version']) ? $name . ' ' . $data['Version'] : $name;
}

/** Updates and installs of plugins, themes, translations and WordPress itself. */
add_action(
	'upgrader_process_complete',
	function ($upgrader, $extra) {
		$type   = isset($extra['type']) ? $extra['type'] : '';
		$action = isset($extra['action']) ? $extra['action'] : '';
		$verb   = $action === 'install' ? 'installed' : 'updated';
		if ($type === 'core') {
			checkout_sentinel_report('wordpress_updated', 'WordPress updated to ' . get_bloginfo('version'));
		} elseif ($type === 'plugin') {
			$plugins = isset($extra['plugins']) ? (array) $extra['plugins'] : array();
			if (isset($extra['plugin'])) {
				$plugins[] = $extra['plugin'];
			}
			if ($action === 'install' && empty($plugins) && $upgrader instanceof Plugin_Upgrader) {
				$plugins[] = $upgrader->plugin_info();
			}
			foreach (array_filter($plugins) as $plugin) {
				checkout_sentinel_report('plugin_' . $verb, 'Plugin ' . $verb . ': ' . checkout_sentinel_plugin_label($plugin));
			}
		} elseif ($type === 'theme') {
			$themes = isset($extra['themes']) ? (array) $extra['themes'] : array();
			if (isset($extra['theme'])) {
				$themes[] = $extra['theme'];
			}
			foreach (array_filter($themes) as $slug) {
				$theme = wp_get_theme($slug);
				$label = $theme->exists() ? $theme->get('Name') . ' ' . $theme->get('Version') : $slug;
				checkout_sentinel_report('theme_' . $verb, 'Theme ' . $verb . ': ' . $label);
			}
		}
	},
	10,
	2
);

add_action(
	'activated_plugin',
	function ($plugin) {
		checkout_sentinel_report('plugin_activated', 'Plugin activated: ' . checkout_sentinel_plugin_label($plugin));
	}
);

add_action(
	'deactivated_plugin',
	function ($plugin) {
		// Deactivating this plugin is reported too, as the last change it can see.
		checkout_sentinel_report('plugin_deactivated', 'Plugin deactivated: ' . checkout_sentinel_plugin_label($plugin));
	}
);

add_action(
	'switch_theme',
	function ($name) {
		checkout_sentinel_report('theme_switched', 'Theme switched to ' . $name);
	}
);

if (is_admin()) {
	require_once __DIR__ . '/includes/settings.php';
}
