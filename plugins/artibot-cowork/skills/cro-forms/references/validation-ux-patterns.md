# Validation UX Patterns & Error Handling

**Core: Real-time validation feedback reduces frustration and form abandonment—choose pattern matching user expectations**

## Validation Pattern Comparison

| Pattern | When to Use | Implementation | Conversion Impact | Effort |
|---------|------------|-----------------|-------------------|--------|
| Inline Real-time | Email, password, username | Check on blur, show ✓/✗ immediately | +3-8% | Medium |
| Descriptive Errors | Complex fields (phone, address) | Format hints + error message | +5-12% | High |
| Success Indicators | Multi-field forms | Green checkmark ✓ per field completed | +2-4% | Low |
| Format Hints | Phone, zip, credit card | "Format: (123) 456-7890" visible | +4-7% | Low |
| Progress Bars | 4+ field forms | Step indicator "1 of 4" | +2-5% | Medium |

## Inline Validation Implementation

**Best Practice:**
1. **On blur (field exit):** Show validation message if error
2. **Color coding:** Red (error), Green (success), Gray (default)
3. **Error message:** "Email must include @domain.com" (not just "Invalid")
4. **Success state:** Green ✓ checkmark, keep visible for confirmation

```
Example Flow:
User enters "john@" → Tab to next field (blur event)
→ Show red error: "Email must include domain"
→ User completes to "john@example.com"
→ Show green ✓ and remove error message
```

## Descriptive Error Messages Checklist

- [ ] Error explains WHAT is wrong ("Missing @symbol")
- [ ] Error explains HOW to fix it ("Include @domain.com")
- [ ] Error message is ≤60 characters
- [ ] Error appears in red text, not just red border
- [ ] Success message (green) appears after fix
- [ ] No jargon—write for non-technical users
- [ ] Message visible on mobile (not cut off)
- [ ] Password: Show strength meter (weak/medium/strong)

## Progressive Profiling Strategy

**Use this pattern to reduce form friction over time:**

**Visit 1:** 2-3 fields
```
Email, Company (B2B only)
↓ Optional: "Learn more about your use case?"
```

**Visit 2 (if returning):** 3-4 fields
```
Email (prefilled), Phone, Budget
↓ Builds trust, incremental ask
```

**Visit 3 (bottom funnel):** All fields
```
Complete info for demo (full qualifying form)
```

## Form Error Handling Checklist

- [ ] No page reload on form submit (async validation)
- [ ] Error summary at top of form if multiple errors
- [ ] Each field error highlighted with icon/color
- [ ] Form doesn't clear on error (preserve user input)
- [ ] Required field validation on blur, not just submit
- [ ] Email field checks format + domain validity
- [ ] Phone field includes country code dropdown
- [ ] Password: Strength meter visible, ≥8 char enforced
- [ ] Checkbox: Visual feedback on check/uncheck
- [ ] Submit button disabled during processing (prevent double-click)
- [ ] Success message appears on submission (not silent success)
