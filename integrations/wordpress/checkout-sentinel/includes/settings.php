<?php
/** Settings > Checkout Sentinel: the API address and key, a connection test, the last report. */

if (!defined('ABSPATH')) {
	exit;
}

add_action(
	'admin_menu',
	function () {
		add_options_page('Checkout Sentinel', 'Checkout Sentinel', 'manage_options', 'checkout-sentinel', 'checkout_sentinel_settings_page');
	}
);

add_action(
	'admin_init',
	function () {
		register_setting(
			'checkout_sentinel',
			CHECKOUT_SENTINEL_OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => 'checkout_sentinel_sanitize',
				'default'           => array(),
			)
		);
	}
);

/** Keeps the stored key when the field is left empty, so saving the URL alone does not erase it. */
function checkout_sentinel_sanitize($input) {
	$current = checkout_sentinel_settings();
	$url     = isset($input['api_url']) ? esc_url_raw(trim((string) $input['api_url']), array('https', 'http')) : '';
	$key     = isset($input['api_key']) ? trim(sanitize_text_field((string) $input['api_key'])) : '';
	if ($key !== '' && strpos($key, 'cs_') !== 0) {
		add_settings_error(CHECKOUT_SENTINEL_OPTION, 'key', __('API keys start with cs_. Create one under API keys in the dashboard.', 'checkout-sentinel'));
		$key = '';
	}
	return array(
		'api_url' => untrailingslashit($url),
		'api_key' => $key !== '' ? $key : $current['api_key'],
	);
}

/** Checks the address and key with a read-only call, without recording a change. */
function checkout_sentinel_test_connection() {
	$settings = checkout_sentinel_settings();
	if ($settings['api_url'] === '' || $settings['api_key'] === '') {
		return __('Save the API address and key first.', 'checkout-sentinel');
	}
	$response = wp_remote_get(
		$settings['api_url'] . '/api/monitors',
		array(
			'timeout' => 5,
			'headers' => array('Authorization' => 'Bearer ' . $settings['api_key']),
		)
	);
	if (is_wp_error($response)) {
		return sprintf(__('Could not reach the API: %s', 'checkout-sentinel'), $response->get_error_message());
	}
	$code = (int) wp_remote_retrieve_response_code($response);
	if ($code === 401) {
		return __('The API refused the key. Create a new one and save it here.', 'checkout-sentinel');
	}
	if ($code !== 200) {
		return sprintf(__('The API answered HTTP %d.', 'checkout-sentinel'), $code);
	}
	return true;
}

function checkout_sentinel_settings_page() {
	if (!current_user_can('manage_options')) {
		return;
	}
	$test = null;
	if (isset($_POST['checkout_sentinel_test']) && check_admin_referer('checkout_sentinel_test')) {
		$test = checkout_sentinel_test_connection();
	}
	$settings = checkout_sentinel_settings();
	$last     = get_option(CHECKOUT_SENTINEL_STATUS_OPTION);
	?>
	<div class="wrap">
		<h1><?php esc_html_e('Checkout Sentinel', 'checkout-sentinel'); ?></h1>
		<p><?php esc_html_e('Plugin, theme and WordPress updates on this site are reported to Checkout Sentinel. When a checkout check fails, its alert lists the changes from the day before.', 'checkout-sentinel'); ?></p>
		<?php if ($test === true) : ?>
			<div class="notice notice-success"><p><?php esc_html_e('Connected. Changes on this site will be reported.', 'checkout-sentinel'); ?></p></div>
		<?php elseif (is_string($test)) : ?>
			<div class="notice notice-error"><p><?php echo esc_html($test); ?></p></div>
		<?php endif; ?>
		<form method="post" action="options.php">
			<?php settings_fields('checkout_sentinel'); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="cs-api-url"><?php esc_html_e('API address', 'checkout-sentinel'); ?></label></th>
					<td>
						<input id="cs-api-url" class="regular-text" type="url" name="<?php echo esc_attr(CHECKOUT_SENTINEL_OPTION); ?>[api_url]" value="<?php echo esc_attr($settings['api_url']); ?>" placeholder="https://app.example.com" />
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="cs-api-key"><?php esc_html_e('API key', 'checkout-sentinel'); ?></label></th>
					<td>
						<input id="cs-api-key" class="regular-text" type="password" autocomplete="off" name="<?php echo esc_attr(CHECKOUT_SENTINEL_OPTION); ?>[api_key]" value="" placeholder="<?php echo esc_attr($settings['api_key'] !== '' ? substr($settings['api_key'], 0, 10) . '…' : 'cs_…'); ?>" aria-describedby="cs-api-key-hint" />
						<p id="cs-api-key-hint" class="description"><?php esc_html_e('From API keys in the dashboard. Leave empty to keep the saved key.', 'checkout-sentinel'); ?></p>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
		<form method="post">
			<?php wp_nonce_field('checkout_sentinel_test'); ?>
			<?php submit_button(__('Test connection', 'checkout-sentinel'), 'secondary', 'checkout_sentinel_test', false); ?>
		</form>
		<?php if (is_array($last)) : ?>
			<h2><?php esc_html_e('Last report', 'checkout-sentinel'); ?></h2>
			<p>
				<?php echo esc_html(wp_date(get_option('date_format') . ' ' . get_option('time_format'), (int) $last['at'])); ?>:
				<?php echo esc_html($last['summary']); ?> —
				<?php echo $last['ok'] ? esc_html__('sent', 'checkout-sentinel') : esc_html(sprintf(__('not sent (%s)', 'checkout-sentinel'), $last['error'])); ?>
			</p>
		<?php endif; ?>
	</div>
	<?php
}
