function footerInfoUpdate(e){sendAjaxPostRequest("/data/info/update",{},function(e){if(4===e.readyState)if(0===e.status);else if(200===e.status||304===e.status){var o=JSON.parse(e.responseText);q("#footer_info").element&&o&&toggleClassByBool(q("#footer_info").element,"no_info",!(o&&o.info))}},{noerr:!0})}var footerInfoTimer;footerInfoTimer=setInterval(footerInfoUpdate,5e3);