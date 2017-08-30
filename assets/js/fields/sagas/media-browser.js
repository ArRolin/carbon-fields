/**
 * The external dependencies.
 */
import { takeEvery, take, call, put, select, all, cancel } from 'redux-saga/effects';
import { isEmpty, isNull, isNumber, isString, isUndefined, first, filter, last, findIndex, isArray } from 'lodash';

/**
 * The internal dependencies.
 */
import { createMediaBrowserChannel } from 'lib/events';
import { getFieldById, getComplexGroupById, getFieldParentById } from 'fields/selectors';
import { getAttachmentThumbnail } from 'fields/helpers';
import {
	setupMediaBrowser,
	openMediaBrowser,
	destroyMediaBrowser,
	updateField,
	setFieldValue,
	addComplexGroup,
	receiveComplexGroup,
	addMultipleFiles,
} from 'fields/actions';
import { TYPE_FILE, TYPE_IMAGE, TYPE_MEDIA_GALLERY } from 'fields/constants';

/**
 * Prepares a field's value depending on its type.
 *
 * @param  {String} fieldId
 * @param  {Object} attachment
 * @return {void}
 */
export function* prepareValueForField(fieldId, attachment) {
	const field = yield select(getFieldById, fieldId);

	if (field.type === TYPE_FILE || field.type === TYPE_IMAGE) {
		return yield prepareValueForFileField(fieldId, attachment);
	} else if (field.type === TYPE_MEDIA_GALLERY) {
		return yield prepareValueForMediaGalleryField(fieldId, attachment);
	}
}

/**
 * Set a field's value depending on it's value_type property
 *
 * @param  {String} fieldId
 * @param  {Object} attachment
 * @return {void}
 */
export function* prepareValueForFileField(fieldId, attachment) {
	const field = yield select(getFieldById, fieldId);
	const value = isUndefined(attachment[field.value_type]) ? attachment.id : attachment[field.value_type];
	return value;
}

/**
 * Prepares a Media Gallery field value.
 *
 * @param  {String} fieldId
 * @param  {Object} attachment
 * @return {void}
 */
export function* prepareValueForMediaGalleryField(fieldId, attachment) {
	const field = yield select(getFieldById, fieldId);

	let {
		value,
		duplicates_allowed,
	} = field;

	const attachmentId = Number(attachment.id);

	if ( ('selected' in field) && isNumber(field.selected) ) {
		const index = value.indexOf(field.selected);

		value.splice(index, 1, attachmentId);

		yield(put(updateField(field.id, {
			selected: '',
		})));
	} else {
		if (duplicates_allowed || field.value.indexOf(attachmentId) === -1) {
			value = [...value, attachmentId];
		}
	}

	return value;
}

/**
 * Add complex groups for every additional attachment selected in the media browser
 *
 * @param  {Object} action
 * @return {void}
 */
export function* workerAddMultipleFiles(action) {
	const { fieldId, attachments, browser } = action.payload;
	const field = yield select(getFieldById, fieldId);

	if (field.type === TYPE_IMAGE || field.type === TYPE_FILE) {
		const parent = yield select(getComplexGroupById, field.parent);
		if (isUndefined(parent)) {
			return;
		}
	}

	for (let i = 0; i < attachments.length; i++) {
		const attachment = attachments[i];

		if (field.type === TYPE_IMAGE || field.type === TYPE_FILE) {
			// add a new group to hold the attachment
			yield put(addComplexGroup(parent.field.id, parent.group.name));

			// pause until the complex is updated
			yield take(receiveComplexGroup);

			// resolve the new field from the new group and assign it's new value
			const parentField = yield select(getFieldById, parent.field.id);
			const freshGroup = last(parentField.value);
			const freshFieldId = first(filter(freshGroup.fields, f => f.base_name === field.base_name)).id;
			const freshField = yield select(getFieldById, freshFieldId);
			const value = yield prepareValueForField(freshField.id, attachment);

			// optional - this ensures an instant preview update
			yield redrawAttachmentPreview(freshField.id, value, attachment, freshField.default_thumb_url);

			yield put(setFieldValue(freshField.id, value));
		} else {
			const value = yield prepareValueForField(field.id, attachment);

			if (field.duplicates_allowed === false) {
				browser.state().frame.options.selected = value;
			}

			// optional - this ensures an instant preview update
			yield redrawAttachmentPreview(field.id, value, attachment, field.default_thumb_url);

			yield put(setFieldValue(field.id, value));
		}
	}
}

/**
 * Trigger a preview redraw action based on an attachment
 *
 * @param  {Object} fieldId
 * @param  {Object} attachmentIdentifier
 * @param  {Object} attachment
 * @param  {String} default_thumb_url
 * @return {void}
 */
export function* redrawAttachmentPreview(fieldId, attachmentIdentifier, attachment, default_thumb_url) {
	const field = yield select(getFieldById, fieldId);

	let attachmentMeta = {
		file_name: '',
		file_url: '',
		file_type: '',
		thumb_url: '',
		preview: '',
		edit_nonce: '',
		title: '',
		caption: '',
		description: '',
	};

	if (!isNull(attachment)) {
		if (isString(attachment)) {
			attachmentMeta.file_name = attachment;
			attachmentMeta.file_url  = attachment;
			attachmentMeta.thumb_url = attachment;
			attachmentMeta.preview   = attachmentIdentifier;
		} else {
			const thumbnail = yield call(getAttachmentThumbnail, attachment);

			attachmentMeta.file_name   = attachment.filename;
			attachmentMeta.file_url    = attachment.url;
			attachmentMeta.file_type   = attachment.type;
			attachmentMeta.thumb_url   = thumbnail || default_thumb_url;
			attachmentMeta.preview     = attachment.id;
			attachmentMeta.edit_nonce  = attachment.nonces ? attachment.nonces.update : '';
			attachmentMeta.title       = attachment.title;
			attachmentMeta.caption     = attachment.caption;
			attachmentMeta.description = attachment.description;
			attachmentMeta.filesize    = attachment.filesizeHumanReadable;
			attachmentMeta.date        = attachment.dateFormatted;

			if (attachment.type === 'image') {
				attachmentMeta.alt    = attachment.alt;
				attachmentMeta.width  = attachment.width;
				attachmentMeta.height = attachment.height;
			} else if (attachment.type === 'audio') {
				attachmentMeta.artist = attachment.meta.artist;
				attachmentMeta.album  = attachment.meta.album;
				attachmentMeta.length = attachment.fileLength;
			}
		}
	}

	if (field.type === TYPE_IMAGE || field.type === TYPE_FILE) {
		yield put(updateField(fieldId, attachmentMeta));
	} else if (field.type === TYPE_MEDIA_GALLERY) {
		let currentValueMeta = field.value_meta;

		currentValueMeta[ attachment.id ] = attachmentMeta;

		yield put(updateField(fieldId, {
			value_meta: currentValueMeta
		}));
	}
}

/**
 * Redraw an attachment preview.
 *
 * @param  {Object} field
 * @param  {Object} action
 * @return {void}
 */
export function* workerRedrawAttachmentPreview(field, action) {
	const {fieldId, value} = action.payload;

	// Don't update the preview if the field doesn't have correct id.
	if (fieldId !== field.id) {
		return;
	}

	// Don't waste time trying to load an already loaded preview
	const freshField = yield select(getFieldById, field.id);
	if (freshField.preview === value) {
		return;
	}

	let attachment = null;
	if (value) {
		if (isNumber(value)) {
			attachment = yield window.wp.media.attachment(value).fetch();
		} else {
			attachment = value; // TODO fix this hack
		}
	}
	yield redrawAttachmentPreview(fieldId, value, attachment, field.default_thumb_url);
}

/**
 * Handle the interaction with media browser of WordPress.
 *
 * @param  {Object} channel
 * @param  {Object} field
 * @param  {Object} browser
 * @param  {Object} action
 * @return {void}
 */
export function* workerOpenMediaBrowser(channel, field, browser, action) {
	// Don't open the browser if the field doesn't have correct id.
	if (action.payload !== field.id) {
		return;
	}

	const liveField = yield select(getFieldById, action.payload);

	browser.once('open', (function (value, selected) {
		let {
			type,
			duplicates_allowed
		} = liveField;

		// For File field, the media should display
		// the currently selected element
		if (type === TYPE_IMAGE || type === TYPE_FILE) {
			var attachment = value ? window.wp.media.attachment(value) : null;
			browser.state().get('selection').set( attachment ? [attachment] : [] );
		}

		if (type === TYPE_MEDIA_GALLERY) {
			if (selected) {
				let attachment = window.wp.media.attachment(selected);
				browser.state().get('selection').set( attachment ? [attachment] : [] );
			} else {
				browser.state().get('selection').set( [] );
			}
		}

		let models = browser.state().get('library').models;
		models.forEach((model) => {
			model.trigger('change', model);
		});
	}).bind(null, liveField.value, liveField.selected));

	yield call([browser, browser.open]);

	while (true) {
		const {
			closed = false,
			selection = undefined
		} = yield take(channel);

		// When the browser is closed, remove the selected flag on the field.
		if (closed) {
			yield put(updateField(field.id, {
				selected: '',
			}));
		}

		if (selection) {
			const [ attachment, ...attachments ] = selection;
			const value = yield prepareValueForField(field.id, attachment);

			if (field.type === TYPE_MEDIA_GALLERY && field.duplicates_allowed === false) {
				browser.state().frame.options.selected = value;
			}

			// optional - this ensures an instant preview update
			yield redrawAttachmentPreview(field.id, value, attachment, field.default_thumb_url);

			yield put(setFieldValue(field.id, value));

			if (!isEmpty(attachments)) {
				yield put(addMultipleFiles(field.id, attachments, browser));
			}
		}
	}
}

/**
 * Initial setup of the media browser.
 *
 * @param  {Object} action
 * @return {void}
 */
export function* workerSetupMediaBrowser(action) {
	const field = yield select(getFieldById, action.payload);
	const {
		window_button_label,
		window_label,
		type_filter,
		value_type,
	} = field;

	const channel = yield call(createMediaBrowserChannel, {
		selected: ! isUndefined(field.duplicates_allowed) && ! field.duplicates_allowed ? field.value : [],
		title: window_label,
		library: {
			type: type_filter,
		},
		button: {
			text: window_button_label
		},
		multiple: true
	});

	const { browser } = yield take(channel);

	yield takeEvery(openMediaBrowser, workerOpenMediaBrowser, channel, field, browser);
	yield takeEvery(setFieldValue, workerRedrawAttachmentPreview, field);

	while (true) {
		const { payload: fieldId } = yield take(destroyMediaBrowser);

		if (field.id === fieldId) {
			yield call([channel, 'close']);
			yield cancel();
			break;
		}
	}
}

/**
 * Start to work.
 *
 * @return {void}
 */
export default function* foreman() {
	yield all([
		takeEvery(setupMediaBrowser, workerSetupMediaBrowser),
		takeEvery(addMultipleFiles, workerAddMultipleFiles),
	]);
}
