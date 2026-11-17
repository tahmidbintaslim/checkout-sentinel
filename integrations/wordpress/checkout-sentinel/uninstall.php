<?php
// Removes the plugin's settings, the API key included, when it is deleted.
if (!defined('WP_UNINSTALL_PLUGIN')) {
	exit;
}
delete_option('checkout_sentinel_settings');
delete_option('checkout_sentinel_last_report');
