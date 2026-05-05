/**
 * CollectedPanel.tsx - Side panel showing the fields collected so far.
 *
 * Features:
 * - Progress bar: (total_fields - missing.length) / total_fields.
 * - Collapsible field list with human-readable labels.
 * - Inline editing: clicking a field value opens an edit input (calls onUpdateField).
 * - AI suggestion badges: shows the `suggestions` tip next to category/severity.
 *
 * `collected` maps field names to their current values.
 * `missing` is the list of fields not yet answered (drives the progress bar).
 */
import { useState } from 'react'
import {
  CONTACT_METHODS,
  ISSUE_TYPES,
  SEVERITY_LEVELS,
  getCategoryOptionsByIssueType,
} from '../constants/incidentSchema'
import './CollectedPanel.css'

type CollectedData = {
  [key: string]: unknown;
}

type CollectedPanelProps = {
  collected: CollectedData;
  missing: string[];
  onUpdateField?: (fieldName: string, value: unknown) => void;
  suggestions?: Record<string, string>;
  readOnly?: boolean;
}

// Valid options for the data_involved multi-select field
const DATA_INVOLVED_OPTIONS = [
  { value: 'personal_info', label: 'Personal Info' },
  { value: 'credentials', label: 'Credentials' },
  { value: 'financial', label: 'Financial' },
  { value: 'company_data', label: 'Company Data' },
  { value: 'other', label: 'Other' },
]

const CYBER_REQUIRED_FIELDS = [
  'description',
  'noticed_time',
  'incident_active',
  'response_taken',
] as const

const IT_SUPPORT_REQUIRED_FIELDS = [
  'description',
  'noticed_time',
  'incident_active',
  'response_taken',
  'affected_asset',
  'error_symptom',
  'category',
] as const

function normalizeIssueTypeForRules(issueType: unknown): string {
  return String(issueType || '').trim().toLowerCase().replace(/\s+/g, '_')
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

function isAffirmativeValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'true' || normalized === 'yes' || normalized === '1'
}

function hasArrayOption(value: unknown, expected: string): boolean {
  return Array.isArray(value)
    && value.some((item) => String(item || '').trim().toLowerCase() === expected)
}

function isFieldVisible(fieldName: string, collected: Record<string, unknown>, issueType: string): boolean {
  const isCyber = issueType === 'cyber'
  const isItSupport = issueType === 'it_support'

  if (CYBER_ONLY_FIELDS.includes(fieldName as typeof CYBER_ONLY_FIELDS[number]) && !isCyber) {
    return false
  }

  if (IT_SUPPORT_ONLY_FIELDS.includes(fieldName as typeof IT_SUPPORT_ONLY_FIELDS[number]) && !isItSupport) {
    return false
  }

  switch (fieldName) {
    case 'location_type':
      return false
    case 'response_details':
      return isAffirmativeValue(collected.response_taken)
    case 'data_involved':
      return isCyber && isAffirmativeValue(collected.data_involved_flag)
    case 'data_other_text':
      return isCyber && hasArrayOption(collected.data_involved, 'other')
    case 'external_party_details':
      return isCyber && isAffirmativeValue(collected.external_party_involved)
    case 'reported_to_details':
      return isCyber && isAffirmativeValue(collected.already_reported_to_it)
    case 'phone_number':
      return String(collected.preferred_contact_method || '').trim().toLowerCase() === 'phone'
    case 'location_detail':
      return true
    case 'category_other_text':
      return String(collected.category || '').trim().toLowerCase() === 'other'
    default:
      return true
  }
}

function getRequiredFieldsByIssueType(issueType: unknown): readonly string[] {
  const normalized = normalizeIssueTypeForRules(issueType)
  if (normalized === 'it_support') return IT_SUPPORT_REQUIRED_FIELDS
  return CYBER_REQUIRED_FIELDS
}

// Base set (23 fields) shown in "Fields to Collect".
const BASE_COLLECTION_FIELDS = [
  'description',
  'category',
  'noticed_time',
  'severity',
  'incident_active',
  'response_taken',
  'response_details',
  'impact_scope',
  'work_continuity',
  'affected_asset',
  'error_symptom',
  'data_involved_flag',
  'data_involved',
  'data_other_text',
  'external_party_involved',
  'external_party_details',
  'already_reported_to_it',
  'reported_to_details',
  'preferred_contact_method',
  'phone_number',
  'location_detail',
  'category_other_text',
] as const

const COMMON_FIELDS = [
  'description',
  'category',
  'noticed_time',
  'severity',
  'incident_active',
  'response_taken',
  'response_details',
  'impact_scope',
  'work_continuity',
  'preferred_contact_method',
  'phone_number',
  'location_detail',
  'category_other_text',
] as const

const CYBER_ONLY_FIELDS = [
  'data_involved_flag',
  'data_involved',
  'data_other_text',
  'external_party_involved',
  'external_party_details',
  'already_reported_to_it',
  'reported_to_details',
] as const

const IT_SUPPORT_ONLY_FIELDS = [
  'affected_asset',
  'error_symptom',
] as const

function formatEnumValue(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function isPendingDerivedField(fieldName: string, collected: CollectedData): boolean {
  if (fieldName === 'issue_type') {
    const issueType = normalizeIssueTypeForRules(collected.issue_type)
    return !issueType || issueType === 'not_sure'
  }

  if (fieldName === 'category' || fieldName === 'severity') {
    return !hasMeaningfulValue(collected[fieldName])
  }

  return false
}

function toDateTimeLocalValue(value: string): string {
  const text = String(value || '').trim()
  if (!text) return ''

  // Already in datetime-local style
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) {
    return text
  }

  // ISO style with seconds/timezone
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/)
  if (iso) {
    return `${iso[1]}T${iso[2]}`
  }

  return ''
}

function CollectedPanel({ collected, missing, onUpdateField, suggestions: _suggestions = {}, readOnly = false }: CollectedPanelProps) {
  const [expanded, setExpanded] = useState(true)
  const [editingField, setEditingField] = useState<string | null>(null)
  const [editValue, setEditValue] = useState<string>('')
  const [editArrayValue, setEditArrayValue] = useState<string[]>([])
  const [editOtherText, setEditOtherText] = useState<string>('')
  void _suggestions

  // Field label mapping for Cyber project
  const fieldLabels: { [key: string]: string } = {
    issue_type: 'Issue Type',
    description: 'Incident Description',
    category: 'Category',
    category_other_text: 'Category Details',
    severity: 'Severity',
    location_detail: 'Location Details',
    noticed_time: 'Time Discovered',
    response_taken: 'Action Taken',
    response_details: 'Action Details',
    affected_asset: 'Affected Asset',
    error_symptom: 'Error Symptom',
    data_involved_flag: 'Data Involved',
    data_involved: 'Data Types',
    data_other_text: 'Other Data Details',
    incident_active: 'Incident Active',
    impact_scope: 'Impact Scope',
    work_continuity: 'Work Continuity',
    external_party_involved: 'External Party',
    external_party_details: 'External Party Details',
    already_reported_to_it: 'Reported to IT',
    reported_to_details: 'IT Report Details',
    preferred_contact_method: 'Contact Method',
    phone_number: 'Phone Number',
  }

  const getFieldLabel = (fieldName: string): string => {
    return fieldLabels[fieldName] || fieldName
  }

  const formatFieldValue = (fieldName: string, value: unknown): string => {
    if (isPendingDerivedField(fieldName, collected)) return 'Pending'

    if (value === null || value === undefined) return '--'

    // Handle boolean
    if (typeof value === 'boolean') {
      return value ? 'Yes' : 'No'
    }

    // Handle array — capitalize each item, remove underscores
    if (Array.isArray(value)) {
      return value.map((v) =>
        typeof v === 'string' ? formatEnumValue(v) : String(v)
      ).join(', ')
    }

    // Handle string — capitalize and remove underscores for enum-like values
    if (typeof value === 'string') {
      const display = value.length > 40 ? value.substring(0, 40) + '...' : value
      // Apply formatting if it looks like a system enum (contains underscore or is all lowercase short word)
      if (value.includes('_') || (value.length <= 20 && value === value.toLowerCase() && !value.includes(' '))) {
        return formatEnumValue(display)
      }
      return display
    }

    return String(value)
  }

  const getInputType = (fieldName: string, value: unknown): 'boolean' | 'enum' | 'datetime' | 'data_involved' | 'array' | 'text' => {
    if (typeof value === 'boolean') return 'boolean'

    if (fieldName === 'noticed_time') return 'datetime'

    if (
      ['issue_type', 'category', 'severity', 'preferred_contact_method'].includes(fieldName)
    ) {
      return 'enum'
    }

    if (['response_taken', 'data_involved_flag', 'incident_active', 'external_party_involved', 'already_reported_to_it'].includes(fieldName)) {
      return 'boolean'
    }

    if (fieldName === 'data_involved') return 'data_involved'
    if (Array.isArray(value)) return 'array'
    return 'text'
  }

  const getEnumOptions = (fieldName: string): Array<{ value: string; label: string }> => {
    if (fieldName === 'issue_type') {
      return ISSUE_TYPES.map((item) => ({ value: item.value, label: item.label }))
    }

    if (fieldName === 'category') {
      const issueType = String(collected.issue_type || '').trim().toLowerCase()
      return getCategoryOptionsByIssueType(issueType || undefined).map((item) => ({
        value: item.value,
        label: item.label,
      }))
    }

    if (fieldName === 'severity') {
      return SEVERITY_LEVELS.map((item) => ({ value: item.value, label: item.label }))
    }

    if (fieldName === 'preferred_contact_method') {
      return CONTACT_METHODS.map((item) => ({ value: item.value, label: item.label }))
    }

    return []
  }

  const startEdit = (fieldName: string) => {
    const currentValue = collected[fieldName]
    const inputType = getInputType(fieldName, currentValue)

    if (inputType === 'data_involved') {
      const arr = Array.isArray(currentValue) ? currentValue : []
      setEditArrayValue(arr)
      setEditOtherText(typeof collected['data_other_text'] === 'string' ? collected['data_other_text'] : '')
    } else if (inputType === 'array') {
      setEditValue(Array.isArray(currentValue) ? currentValue.join(', ') : '')
    } else {
      const asText = currentValue === null || currentValue === undefined
        ? ''
        : String(currentValue)
      if (inputType === 'datetime') {
        setEditValue(toDateTimeLocalValue(asText))
      } else {
        setEditValue(asText)
      }
      setEditArrayValue([])
      setEditOtherText('')
    }

    setEditingField(fieldName)
  }

  const cancelEdit = () => {
    setEditingField(null)
    setEditValue('')
    setEditArrayValue([])
    setEditOtherText('')
  }

  const saveEdit = (fieldName: string) => {
    if (!onUpdateField) {
      cancelEdit()
      return
    }

    const currentValue = collected[fieldName]
    const inputType = getInputType(fieldName, currentValue)
    let parsedValue: unknown = editValue

    if (inputType === 'boolean') {
      const lowered = editValue.trim().toLowerCase()
      parsedValue = lowered === 'true' || lowered === 'yes' || lowered === '1'
    } else if (inputType === 'data_involved') {
      parsedValue = editArrayValue
      // Also save the other text if "other" is selected
      if (editArrayValue.includes('other') && editOtherText.trim()) {
        onUpdateField('data_other_text', editOtherText.trim())
      }
    } else if (inputType === 'array') {
      parsedValue = editValue
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    } else if (inputType === 'datetime') {
      parsedValue = editValue.trim()
    } else {
      parsedValue = editValue.trim()
    }

    onUpdateField(fieldName, parsedValue)
    cancelEdit()
  }

  const toggleEditArrayItem = (value: string) => {
    setEditArrayValue((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    )
  }

  const collectedFields = Array.from(new Set([
    'issue_type',
    ...Object.keys(collected),
    ...(hasMeaningfulValue(collected.description) ? ['category', 'severity'] : []),
  ])).filter((k) => {
    if (k === 'location_type') return false
    if (!isFieldVisible(k, collected, normalizeIssueTypeForRules(collected.issue_type))) return false
    if (isPendingDerivedField(k, collected)) return true
    return hasMeaningfulValue(collected[k])
  })

  const issueType = normalizeIssueTypeForRules(collected.issue_type)
  const visibleFieldSet = new Set<string>(
    BASE_COLLECTION_FIELDS.filter((field) => isFieldVisible(field, collected, issueType))
  )

  const fieldPlanBaseOrder = BASE_COLLECTION_FIELDS.filter((field) => visibleFieldSet.has(field))
  const requiredSet = new Set<string>(getRequiredFieldsByIssueType(collected.issue_type))

  // Use local "is empty" truth as the canonical missing source for this panel.
  const localMissingFields = fieldPlanBaseOrder.filter((field) => !hasMeaningfulValue(collected[field]))
  // Keep backend missing only when it exists in the active plan.
  const backendMissingInPlan = missing.filter((field) => visibleFieldSet.has(field))
  const unifiedMissingFields = Array.from(new Set([...localMissingFields, ...backendMissingInPlan]))

  const missingPlanItems = fieldPlanBaseOrder
    .filter((field) => fieldLabels[field] && unifiedMissingFields.includes(field))
    .map((field) => ({
      field,
      required: requiredSet.has(field),
    }))
    .sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1
      return 0
    })

  const totalVisible = fieldPlanBaseOrder.length
  const visibleCollectedCount = fieldPlanBaseOrder.filter((field) => hasMeaningfulValue(collected[field])).length

  const requiredComplete = Array.from(requiredSet)
    .every((field) => !visibleFieldSet.has(field) || hasMeaningfulValue(collected[field]))
  const allVisibleComplete = totalVisible > 0 && visibleCollectedCount === totalVisible
  const progressTone = allVisibleComplete ? 'green' : requiredComplete ? 'amber' : 'red'
  const progressStatusText = allVisibleComplete
    ? 'All fields completed'
    : requiredComplete
      ? 'Required fields completed'
      : 'Required fields missing'

  return (
    <div className="collected-panel">
      <div className="panel-header" onClick={() => setExpanded(!expanded)}>
        <button className="expand-btn" type="button">
          {expanded ? '▼' : '▶'}
        </button>
        <h2>📋 Collected Information</h2>
      </div>

      {expanded && (
        <div className="panel-body">
          <div className={`progress-status-bar is-${progressTone}`} role="status" aria-live="polite">
            <span className="progress-status-text">{progressStatusText}</span>
            <span className="progress-status-count">{visibleCollectedCount}/{totalVisible}</span>
          </div>

          {collectedFields.length > 0 ? (
            <ul className="field-list">
              {collectedFields.map(fieldName => (
                <li key={fieldName} className="field-item">
                  <span className="field-label">{getFieldLabel(fieldName)}</span>
                  {!readOnly && editingField === fieldName ? (
                    <div className="field-edit-area">
                      {getInputType(fieldName, collected[fieldName]) === 'boolean' ? (
                        <select
                          className="field-edit-input"
                          value={editValue.toLowerCase() === 'true' || editValue.toLowerCase() === 'yes' ? 'true' : 'false'}
                          onChange={(e) => setEditValue(e.target.value)}
                        >
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </select>
                      ) : getInputType(fieldName, collected[fieldName]) === 'enum' ? (
                        <select
                          className="field-edit-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                        >
                          <option value="">-- Select --</option>
                          {getEnumOptions(fieldName).map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      ) : getInputType(fieldName, collected[fieldName]) === 'datetime' ? (
                        <input
                          type="datetime-local"
                          className="field-edit-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                        />
                      ) : getInputType(fieldName, collected[fieldName]) === 'data_involved' ? (
                        <div>
                          <div className="field-edit-checkboxes">
                            {DATA_INVOLVED_OPTIONS.map((opt) => (
                              <label key={opt.value} className="field-edit-checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={editArrayValue.includes(opt.value)}
                                  onChange={() => toggleEditArrayItem(opt.value)}
                                />
                                <span>{opt.label}</span>
                              </label>
                            ))}
                          </div>
                          {editArrayValue.includes('other') && (
                            <input
                              className="field-edit-input"
                              style={{ marginTop: '6px' }}
                              value={editOtherText}
                              onChange={(e) => setEditOtherText(e.target.value)}
                              placeholder="Describe the other data type"
                            />
                          )}
                        </div>
                      ) : (
                        <input
                          className="field-edit-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          placeholder={getInputType(fieldName, collected[fieldName]) === 'array' ? 'value1, value2' : 'Enter corrected value'}
                        />
                      )}
                      <div className="field-edit-actions">
                        <button type="button" className="field-action-btn save" onClick={() => saveEdit(fieldName)}>
                          Save
                        </button>
                        <button type="button" className="field-action-btn cancel" onClick={cancelEdit}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="field-value" title={String(collected[fieldName])}>
                        {formatFieldValue(fieldName, collected[fieldName])}
                      </span>
                      {!readOnly && onUpdateField && (
                        <button
                          type="button"
                          className="field-action-btn edit"
                          onClick={() => startEdit(fieldName)}
                        >
                          Edit
                        </button>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-message">No information has been collected yet</p>
          )}

          {missingPlanItems.length > 0 && (
            <div className="missing-section">
              <h3>Fields to Collect ({missingPlanItems.length})</h3>
              <ul className="missing-list">
                {missingPlanItems.map((item) => (
                  <li key={item.field} className="missing-item">
                    <span className="missing-item-label">
                      {getFieldLabel(item.field)}
                      {item.required ? ' *' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="panel-tip">
            {readOnly
              ? '💡 Complete all questions to enable editing collected values'
              : '💡 You can edit collected values before submitting the report'}
          </div>
        </div>
      )}
    </div>
  )
}

export default CollectedPanel
